/**
 * privacykey — hero binary rain + cursor emitter
 *
 * Two layers:
 *  1. Background rain — Three.js fragment shader draws falling 0s and 1s,
 *     with the letters "PRIVACY KEY" revealed as a brighter green mask.
 *  2. Cursor emitter — a 2D canvas overlay running a small particle
 *     system. The cursor emits glyph particles that fly outward, tumble,
 *     fall under gravity, and fade out.
 *
 * Accessibility / perf:
 *  - Bails out entirely under prefers-reduced-motion.
 *  - Container is aria-hidden + pointer-events: none (inputs stay usable).
 *  - DPR capped at 2, animation paused when tab is hidden.
 *  - Particle pool capped to avoid runaway memory/CPU.
 */
(function () {
  'use strict';

  // Reduced-motion + Three.js availability are page-level checks — do
  // them once before iterating any [data-hero-rain] element.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  var THREE = window.THREE;
  if (!THREE) {
    console.warn('[hero-rain] Three.js not loaded');
    return;
  }

  // Registry of every initialised rain instance — populated by setupRain
  // as it bootstraps each [data-hero-rain] element. Easter eggs that
  // operate across instances (Konami palette swap, spell-once) iterate
  // this array. Each entry exposes the instance's uniforms and a
  // discriminator for "is this the hero rain?".
  var rainInstances = [];

  // Each [data-hero-rain] element gets its own renderer / scene /
  // uniforms / observers / animation loop. The hero uses the full
  // package (roofs, double rect, cursor emitter); other instances
  // (e.g. the footer band) just inherit empty arrays for those and
  // render falling glyphs.
  function setupRain(root) {

  var rainCanvas = root.querySelector('canvas');
  if (!rainCanvas) return;

  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  // =====================================================================
  // LAYER 1 — Background rain (Three.js)
  // =====================================================================

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: rainCanvas,
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'low-power'
    });
  } catch (err) {
    console.warn('[hero-rain] WebGL unavailable', err);
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(dpr);

  var scene = new THREE.Scene();
  var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;

  // Text mask: "PRIVACY KEY" rendered to an offscreen canvas.
  var maskCanvas = document.createElement('canvas');
  var maskCtx = maskCanvas.getContext('2d');
  var maskTex = new THREE.CanvasTexture(maskCanvas);
  maskTex.minFilter = THREE.LinearFilter;
  maskTex.magFilter = THREE.LinearFilter;
  maskTex.generateMipmaps = false;

  function renderMask(w, h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
    maskCtx.clearRect(0, 0, w, h);
    var shortest = Math.min(w, h);
    var size = Math.max(42 * dpr, Math.min(w / 6.2, shortest * 0.40));
    maskCtx.fillStyle = '#fff';
    maskCtx.textAlign = 'center';
    maskCtx.textBaseline = 'middle';
    maskCtx.font = '800 ' + size + "px 'Inter', system-ui, -apple-system, sans-serif";
    maskCtx.fillText('PRIVACY KEY', w / 2, h / 2);
    maskCtx.fillText('PRIVACY KEY', w / 2 + 1, h / 2);
    maskTex.needsUpdate = true;
  }

  // Up to MAX_ROOFS rectangles can absorb rain — currently the "control"
  // accent in the headline plus the two CTA buttons in the hero. Sized
  // generously so adding a third button later doesn't need a shader edit.
  var MAX_ROOFS = 4;

  var uniforms = {
    uTime:       { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uMask:       { value: maskTex },
    uCell:       { value: 14 },
    // Each entry is (x0, yTopFromTop, x1, yBotFromTop) in device pixels.
    // uRoofCount caps the active range; trailing slots are ignored.
    uRoofs:      { value: [
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0),
      new THREE.Vector4(0, 0, 0, 0)
    ] },
    uRoofCount:  { value: 0 },
    // Bounding rect of the word "privacy" in the headline (device pixels,
    // top-relative), where each rain cell renders two glyphs side-by-side
    // instead of one. Same coord system as uRoofs but does NOT zero alpha
    // or trigger particle bouncing — rain falls right through, just doubled.
    uDouble:     { value: new THREE.Vector4(0, 0, 0, 0) },
    // Easter-egg cut range: (xMin, xMax) in device pixels. Pixels in this
    // X-strip have alpha multiplied to zero with a soft edge fade. Driven
    // by the privacykey-logo drag interaction on the footer rain band.
    uCutX:       { value: new THREE.Vector2(0, 0) },
    // Rain palette — hoisted to uniforms so the Konami easter egg can
    // swap to the privacycommand indigo palette without recompiling.
    uColorGreen:     { value: new THREE.Vector3(0.188, 0.820, 0.345) },  // privacykey #30D158
    uColorGreenHead: { value: new THREE.Vector3(0.525, 0.937, 0.675) },
    uColorDarkGreen: { value: new THREE.Vector3(0.086, 0.396, 0.204) },  // privacykey #166534
    // Spell easter egg: 0 = normal rain, 1 = alpha multiplied by mask so
    // only pixels inside the "PRIVACY KEY" wordmark stay visible. JS
    // animates this in/out once a session.
    uSpellAmount: { value: 0 }
  };

  var vertexShader = [
    'void main() {',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  var fragmentShader = [
    'precision mediump float;',
    'uniform float uTime;',
    'uniform vec2  uResolution;',
    'uniform sampler2D uMask;',
    'uniform float uCell;',
    'uniform vec4  uRoofs[4]; // x0, yTopFromTop, x1, yBotFromTop (pixels)',
    'uniform int   uRoofCount;',
    'uniform vec4  uDouble;   // bounding rect of "privacy" — glyphs double inside',
    'uniform vec2  uCutX;     // (xMin, xMax) in device pixels — easter-egg cut zone',
    'uniform vec3  uColorGreen;     // mid-trail colour (driven by Konami easter egg)',
    'uniform vec3  uColorGreenHead; // bright trail head',
    'uniform vec3  uColorDarkGreen; // deep trail tone (used inside privacy band)',
    'uniform float uSpellAmount;    // 0 = normal, 1 = only wordmark pixels visible',

    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',

    'float glyph(vec2 p, float which){',
    '  vec2 q = p - 0.5;',
    '  if(which < 0.5){',
    '    float r = length(q);',
    '    return smoothstep(0.34, 0.29, r) - smoothstep(0.22, 0.17, r);',
    '  }',
    '  float stem = step(abs(q.x + 0.02), 0.055) * step(-0.33, q.y) * step(q.y, 0.28);',
    '  float foot = step(abs(q.x), 0.18)        * step(-0.36, q.y) * step(q.y, -0.30);',
    '  float hat  = step(abs(q.x + 0.09), 0.08) * step( 0.14, q.y) * step(q.y,  0.28);',
    '  return clamp(stem + foot + hat, 0.0, 1.0);',
    '}',

    'void main(){',
    '  vec2 pixel = gl_FragCoord.xy;',
    '  float pxTop = uResolution.y - pixel.y;  // y-from-top, used by roof + double',
    '  vec2 idx = floor(pixel / uCell);',
    '  vec2 uv  = fract(pixel / uCell);',

    '  float colRand = hash(vec2(idx.x, 1.234));',
    '  float speed   = 2.6 + colRand * 4.2;',
    '  float colOff  = colRand * 60.0;',
    '  float totalRows = uResolution.y / uCell + 20.0;',

    '  float rowFromTop = pxTop / uCell;',
    '  float head = mod(uTime * speed + colOff, totalRows + 24.0) - 12.0;',
    '  float dist = rowFromTop - head;',
    '  float inTrail = step(-0.5, dist) * smoothstep(16.0, 0.0, dist);',

    '  float flipTime = floor(uTime * (1.5 + colRand * 2.2));',
    '  float which = step(0.5, hash(idx + vec2(flipTime, 7.7)));',

    '  vec2 maskUV = vec2(pixel.x / uResolution.x, 1.0 - pixel.y / uResolution.y);',
    '  float mask = texture2D(uMask, maskUV).r;',

    // ---- "privacy" band detection ----
    //  overDouble is 1.0 when the pixel is inside the uDouble rect, 0.0
    //  otherwise. Used for both glyph doubling AND for shifting the rain
    //  palette to a darker green so the band reads as a different mood.
    '  float overDouble = step(uDouble.x, pixel.x) * step(pixel.x, uDouble.z)',
    '                   * step(uDouble.y, pxTop)   * step(pxTop,   uDouble.w)',
    '                   * step(0.001, uDouble.z - uDouble.x);',

    '  float g = glyph(uv, which);',
    // ---- Doubling: rain over the "privacy" word renders two glyphs per
    //                cell so the binary visibly doubles in that band. Each
    //                half independently picks a 0/1 via the same hash seed
    //                offset by halfCol so the digits don't repeat.
    '  if (overDouble > 0.5) {',
    '    float halfCol = step(0.5, uv.x);',                 // 0 = left half, 1 = right
    '    vec2 uvHalf = vec2(fract(uv.x * 2.0), uv.y);',
    '    float which2 = step(0.5, hash(idx + vec2(flipTime + halfCol * 13.0, 7.7)));',
    '    g = glyph(uvHalf, which2);',
    '  }',

    '  vec3 dim          = vec3(0.38, 0.52, 0.64);',
    '  vec3 green        = uColorGreen;',                 // mutable via Konami remix
    '  vec3 greenHead    = uColorGreenHead;',
    '  vec3 darkGreen    = uColorDarkGreen;',
    '  vec3 color = mix(dim, green, mask);',
    // Inside the "privacy" band, push the trail strongly toward the deep
    // privacykey green so the doubled binary reads as a denser, moodier
    // strip without losing legibility.
    '  color = mix(color, darkGreen, overDouble * 0.9);',

    '  float headGlow = smoothstep(1.8, 0.0, abs(dist));',
    // Trail heads outside privacy use the bright greenHead. Inside, drop
    // to plain green so heads still pop against the darker trail without
    // washing the band back to bright.
    '  vec3 headColor = mix(greenHead, green, overDouble);',
    '  color = mix(color, headColor, headGlow * (0.35 + mask * 0.55));',

    '  float alpha = g * inTrail;',
    '  alpha *= mix(0.32, 1.0, mask);',
    '  alpha *= 0.85;',

    // ---- Roofs: zero-out any rain landing inside any active rect, and
    //              add a tiny splash highlight along each rect's top edge.
    //              Loops over uRoofs[0..uRoofCount); GLSL ES requires the
    //              loop bound to be the constant MAX_ROOFS = 4. pxTop is
    //              already declared at the top of main().
    '  for (int i = 0; i < 4; i++) {',
    '    if (i >= uRoofCount) break;',
    '    vec4 r = uRoofs[i];',
    '    if (r.z <= r.x || r.w <= r.y) continue;',
    '    if (pixel.x >= r.x && pixel.x <= r.z &&',
    '        pxTop   >= r.y && pxTop   <= r.w) {',
    '      alpha = 0.0;',
    '    } else {',
    '      float distTop = pxTop - r.y;',
    '      float nearTop = smoothstep(4.0, 0.0, abs(distTop));',
    '      float overlapX = step(r.x, pixel.x) * step(pixel.x, r.z);',
    '      float above    = step(0.0, -distTop);  // only above the roof',
    '      float splash = nearTop * overlapX * above * 0.35 * inTrail;',
    '      color = mix(color, greenHead, splash);',
    '      alpha = max(alpha, splash * 0.6);',
    '    }',
    '  }',

    // ---- Spell: easter-egg "rain spells PRIVACY KEY" pulse. As
    //              uSpellAmount climbs to 1, alpha gets multiplied by
    //              the wordmark mask, leaving only the letters lit.
    '  alpha *= mix(1.0, mask, uSpellAmount);',

    // ---- Cut: easter-egg slash. Pixels inside the cut X-range fade to
    //          alpha 0; the edges feather over a few pixels so the cut
    //          reads as carved rather than a clean rectangle.
    '  if (uCutX.y > uCutX.x) {',
    '    float dx = max(uCutX.x - pixel.x, pixel.x - uCutX.y);',
    '    float kill = 1.0 - smoothstep(0.0, 8.0, dx);',
    '    alpha *= 1.0 - kill;',
    '  }',

    '  gl_FragColor = vec4(color, alpha);',
    '}'
  ].join('\n');

  var material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending
  });

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  // =====================================================================
  // LAYER 2 — Particle emitter (2D canvas overlay)
  // =====================================================================

  var partCanvas = document.createElement('canvas');
  partCanvas.setAttribute('aria-hidden', 'true');
  partCanvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;' +
    'pointer-events:none;display:block;';
  root.appendChild(partCanvas);
  var partCtx = partCanvas.getContext('2d');

  // ---- Roofs: bounding rects the rain can't pass through ----
  // The "in control" accent in the headline plus the two CTA buttons
  // (Explore privacy tools, View on GitHub) all act as roofs the rain
  // dies on and bounces off. Queried after layout (on load + resize)
  // and consumed by both the shader and particle AABB collisions.
  // The "privacy" word in the headline is tracked separately as
  // doubleEl/doubleRect — rain falls *through* it but each cell renders
  // two glyphs side-by-side, so the binary visibly doubles in that band.
  var hero0 = root.parentElement;
  var roofTargets = [];
  var doubleEl = null;
  if (hero0) {
    var accentEl = hero0.querySelector('.accent');
    if (accentEl) roofTargets.push(accentEl);
    var btns = hero0.querySelectorAll('.hero-actions .btn');
    for (var bi = 0; bi < btns.length && roofTargets.length < MAX_ROOFS; bi++) {
      roofTargets.push(btns[bi]);
    }
    doubleEl = hero0.querySelector('.word-privacy');
  }
  // roofRects is an array of {x, y, w, h} in CSS px relative to root's
  // top-left. Empty when no targets are present or visible.
  var roofRects = [];
  var doubleRect = null;

  // Compute a single rect (CSS px relative to root) for an element, or
  // null if the element is missing/zero-size.
  function rectFor(el, rRect) {
    if (!el) return null;
    var aRect = el.getBoundingClientRect();
    var padY = 2;
    var w = Math.max(0, aRect.width);
    var h = Math.max(0, aRect.height);
    if (w < 4 || h < 4) return null;
    return {
      x: aRect.left - rRect.left,
      y: aRect.top  - rRect.top - padY,
      w: w,
      h: h + padY * 2
    };
  }

  function updateRoofRect() {
    var rRect = root.getBoundingClientRect();
    var rects = [];
    for (var i = 0; i < roofTargets.length; i++) {
      var r = rectFor(roofTargets[i], rRect);
      if (r) rects.push(r);
    }
    roofRects = rects;
    doubleRect = rectFor(doubleEl, rRect);
  }

  var MAX_PARTICLES = 80;
  var particles = [];

  // True if (x, y) in CSS px relative to root lies inside any roof.
  function insideRoof(x, y) {
    for (var i = 0; i < roofRects.length; i++) {
      var r = roofRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
    }
    return false;
  }

  // True if (x, y) in CSS px relative to root lies inside the "privacy"
  // doubling rect — used to colour particles dark green at spawn time so
  // they match the rain's palette inside that band.
  function insideDouble(x, y) {
    var r = doubleRect;
    if (!r) return false;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  // One-shot spawn: a glyph appears at (x, y) with a random outward velocity
  // and spin. `moveSpeed` (px/s of the cursor) boosts particle velocity so
  // faster flicks throw particles further.
  function spawn(x, y, moveSpeed) {
    // Don't spawn anything already trapped inside the roof — they'd just get
    // stuck bouncing under opaque text.
    if (insideRoof(x, y)) return;
    if (particles.length >= MAX_PARTICLES) {
      // Reuse the oldest slot to keep memory flat.
      particles.shift();
    }
    // Particles born over the "privacy" word are tagged once and given
    // a longer life so the band reads as a denser, longer-lasting
    // disturbance than the rest of the hero. Initial speed is left at
    // the regular value — the cursor's flick velocity still governs
    // launch energy as elsewhere; the longer life is what lets them
    // drift further from the cursor before fading.
    var over = insideDouble(x, y);
    var angle = Math.random() * Math.PI * 2;
    var speed = 35 + Math.random() * 120 + Math.min(moveSpeed, 1200) * 0.15;
    var life  = 0.7 + Math.random() * 0.7;
    if (over) life *= 2.0;              // hang around longer
    particles.push({
      x: x, y: y,
      px: x, py: y, // previous position — used by roof collision
      vx: Math.cos(angle) * speed,
      // Slight upward kick on half of them so they arc before falling.
      vy: Math.sin(angle) * speed - (Math.random() < 0.5 ? 35 : 0),
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 6,
      age: 0,
      life: life,
      glyph: Math.random() < 0.5 ? '0' : '1',
      size: 10 + Math.random() * 4,
      // Inherit the darker privacykey green so they match the rain
      // palette in that band. Tagged once; colour stays as it arcs.
      color: over ? '#166534' : '#30D158'
    });
  }

  var GRAVITY = 340;           // px/s^2 downward
  var DRAG_PER_SEC = 0.55;     // fraction of velocity retained each second
  var ROOF_BOUNCE = 0.45;      // elasticity on collision with the headline
  var ROOF_TANGENT_DAMP = 0.82; // velocity parallel to the surface is scrubbed

  // Resolve collision with each roof AABB using the particle's previous
  // position to pick the entry side, then reflect velocity and offset so
  // the particle ends outside the rect. Iterates roofRects until one
  // resolves; with a few small rects the cost is trivial.
  function collideRoof(p) {
    for (var i = 0; i < roofRects.length; i++) {
      var r = roofRects[i];
      var x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;

      var fromAbove = p.py <= y0;
      var fromBelow = p.py >= y1;
      var fromLeft  = p.px <= x0;
      var fromRight = p.px >= x1;

      if (fromAbove) {
        p.y = y0 - 0.5;
        p.vy = -Math.abs(p.vy) * ROOF_BOUNCE;
        p.vx *= ROOF_TANGENT_DAMP;
      } else if (fromBelow) {
        p.y = y1 + 0.5;
        p.vy = Math.abs(p.vy) * ROOF_BOUNCE;
        p.vx *= ROOF_TANGENT_DAMP;
      } else if (fromLeft) {
        p.x = x0 - 0.5;
        p.vx = -Math.abs(p.vx) * ROOF_BOUNCE;
        p.vy *= ROOF_TANGENT_DAMP;
      } else if (fromRight) {
        p.x = x1 + 0.5;
        p.vx = Math.abs(p.vx) * ROOF_BOUNCE;
        p.vy *= ROOF_TANGENT_DAMP;
      } else {
        // Spawned/landed inside with no clear entry side — eject upward.
        p.y = y0 - 0.5;
        p.vy = -Math.abs(p.vy || 60) * ROOF_BOUNCE;
      }
      return; // resolved one rect; another collision will be picked up next frame
    }
  }

  function updateParticles(dt) {
    // Pow for frame-rate-independent exponential drag.
    var dragK = Math.pow(DRAG_PER_SEC, dt);
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy += GRAVITY * dt;
      p.vx *= dragK;
      p.vy *= dragK;
      p.px = p.x; p.py = p.y;
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.rot += p.rotVel * dt;
      collideRoof(p);
    }
  }

  function drawParticles() {
    partCtx.clearRect(0, 0, partCanvas.width, partCanvas.height);
    if (!particles.length) return;
    partCtx.textAlign = 'center';
    partCtx.textBaseline = 'middle';
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var t = p.age / p.life;
      // Ease: quick pop-in, slow fade-out.
      var fadeIn = t < 0.08 ? (t / 0.08) : 1;
      var fadeOut = 1 - Math.pow(t, 2.2);
      var alpha = Math.max(0, Math.min(1, fadeIn * fadeOut)) * 0.9;

      partCtx.save();
      partCtx.translate(p.x * dpr, p.y * dpr);
      partCtx.rotate(p.rot);
      partCtx.globalAlpha = alpha;
      partCtx.fillStyle = p.color || '#30D158';
      partCtx.font = '700 ' + (p.size * dpr).toFixed(1) +
        "px 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
      partCtx.fillText(p.glyph, 0, 0);
      partCtx.restore();
    }
  }

  // =====================================================================
  // Pointer tracking — drives the emitter (not the rain).
  // =====================================================================

  var hero = root.parentElement || root;
  var lastX = 0, lastY = 0, lastT = 0;
  var cursorInside = false;
  var cursorX = 0, cursorY = 0; // in CSS pixels, relative to root

  function onPointerMove(e) {
    var rect = root.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var now = performance.now();

    var moveSpeed = 0;
    if (cursorInside) {
      var dx = x - lastX, dy = y - lastY;
      var dt = Math.max(1, now - lastT);
      moveSpeed = Math.hypot(dx, dy) / dt * 1000; // px/s
    }

    // Spawn count scales with movement speed. Keeps idle density low: only
    // fast flicks emit more than one particle per event.
    var count = Math.min(2, 1 + Math.floor(moveSpeed / 650));
    // Gate very slow movement — otherwise tiny tremors spawn a lot.
    if (moveSpeed < 30) count = Math.random() < 0.35 ? 1 : 0;
    for (var i = 0; i < count; i++) {
      var jx = x + (Math.random() - 0.5) * 6;
      var jy = y + (Math.random() - 0.5) * 6;
      spawn(jx, jy, moveSpeed);
    }

    lastX = x; lastY = y; lastT = now;
    cursorX = x; cursorY = y;
    cursorInside = true;
  }
  function onPointerLeave() { cursorInside = false; }

  hero.addEventListener('pointermove', onPointerMove, { passive: true });
  hero.addEventListener('pointerleave', onPointerLeave, { passive: true });

  // Baseline trickle while the cursor is stationary but inside the hero —
  // keeps the emitter feeling "on" instead of only reacting to movement.
  var trickleAccum = 0;
  function maybeTrickle(dt) {
    if (!cursorInside) return;
    trickleAccum += dt;
    var interval = 0.22; // one particle roughly every 220 ms when idle
    while (trickleAccum >= interval) {
      trickleAccum -= interval;
      spawn(
        cursorX + (Math.random() - 0.5) * 6,
        cursorY + (Math.random() - 0.5) * 6,
        0
      );
    }
  }

  // =====================================================================
  // Resize
  // =====================================================================

  function pushRoofUniform() {
    var slots = uniforms.uRoofs.value;
    for (var i = 0; i < MAX_ROOFS; i++) {
      var r = roofRects[i];
      if (r) {
        slots[i].set(
          r.x * dpr,
          r.y * dpr,
          (r.x + r.w) * dpr,
          (r.y + r.h) * dpr
        );
      } else {
        slots[i].set(0, 0, 0, 0);
      }
    }
    uniforms.uRoofCount.value = Math.min(roofRects.length, MAX_ROOFS);

    // Push the "privacy" doubling rect (or zero it out if absent).
    if (doubleRect) {
      uniforms.uDouble.value.set(
        doubleRect.x * dpr,
        doubleRect.y * dpr,
        (doubleRect.x + doubleRect.w) * dpr,
        (doubleRect.y + doubleRect.h) * dpr
      );
    } else {
      uniforms.uDouble.value.set(0, 0, 0, 0);
    }
  }

  function resize() {
    var rect = root.getBoundingClientRect();
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));

    // Rain (Three.js)
    renderer.setSize(w, h, false);
    rainCanvas.style.width  = w + 'px';
    rainCanvas.style.height = h + 'px';
    uniforms.uResolution.value.set(w * dpr, h * dpr);
    var cell = 12 + Math.min(6, w / 240);
    uniforms.uCell.value = cell * dpr;
    renderMask(w * dpr, h * dpr);

    // Particle canvas
    partCanvas.width  = w * dpr;
    partCanvas.height = h * dpr;
    partCanvas.style.width  = w + 'px';
    partCanvas.style.height = h + 'px';

    updateRoofRect();
    pushRoofUniform();
  }
  resize();
  // Fonts can finish loading after the first resize, nudging .accent's rect
  // (especially on first paint). Recompute once fonts settle.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      updateRoofRect();
      pushRoofUniform();
    });
  }
  window.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(resize).observe(root);
    // Headline, buttons, and the "privacy" word can rewrap or rescale
    // without the hero itself changing size (e.g. when the scrollbar
    // appears, or fonts settle). Watch every target so rects stay
    // aligned with what the user sees.
    var rectObserver = new ResizeObserver(function () {
      updateRoofRect();
      pushRoofUniform();
    });
    for (var ri = 0; ri < roofTargets.length; ri++) {
      rectObserver.observe(roofTargets[ri]);
    }
    if (doubleEl) rectObserver.observe(doubleEl);
  }

  // =====================================================================
  // Easter egg — drag the privacykey logo across this rain band to cut it.
  //  - Active only on the .footer-rain instance.
  //  - Drag covers a soft x-range while pointer is inside the band; the
  //    range is pushed into uCutX which the shader uses to fade alpha.
  //  - On release, ≥70% width = freeze (rain stays cut), else heal.
  //  - Pointer events used so mouse + touch share one path.
  // =====================================================================

  if (root.classList.contains('footer-rain')) {
    var footerEl = root.closest && root.closest('footer');
    var logoImg = footerEl ? footerEl.querySelector('.footer-brand img') : null;
    if (logoImg) (function setupCut () {
      var dragging = false;
      var startX = 0, startY = 0;
      var cutMin = 0, cutMax = 0;
      var cutActive = false;
      var cutFrozen = false;
      var healRaf = 0;
      // Long-press easter egg: holding the logo still for 1500ms while
      // pressed triggers a green sparkle pulse + a tiny tooltip linking
      // to the GitHub org. Cancelled if the pointer moves > 5px.
      var longPressTimer = 0;
      var longPressFired = false;

      // Affordance — tells the user the logo is grabbable without
      // shouting about it.
      logoImg.style.cursor = 'grab';
      logoImg.style.touchAction = 'none';
      logoImg.style.userSelect = 'none';
      logoImg.draggable = false;          // suppress native drag-image ghost
      // Make the parent .footer-brand the anchor for the absolute tooltip.
      if (logoImg.parentElement) logoImg.parentElement.style.position = 'relative';

      function fireLongPress () {
        longPressFired = true;
        logoImg.classList.add('pk-pulse');
        setTimeout(function () { logoImg.classList.remove('pk-pulse'); }, 720);
        // Tooltip — small floating link to the GitHub org. Removed after
        // ~3.5s. Only one tooltip exists at a time.
        var existing = logoImg.parentElement && logoImg.parentElement.querySelector('.pk-thanks');
        if (existing) existing.remove();
        var tip = document.createElement('a');
        tip.className = 'pk-thanks';
        tip.href = 'https://github.com/privacykey';
        tip.target = '_blank';
        tip.rel = 'noopener';
        tip.textContent = 'thanks — github.com/privacykey';
        if (logoImg.parentElement) logoImg.parentElement.appendChild(tip);
        requestAnimationFrame(function () { tip.classList.add('show'); });
        setTimeout(function () { tip.classList.remove('show'); }, 3000);
        setTimeout(function () { if (tip.parentElement) tip.remove(); }, 3700);
      }

      function pushCut () {
        if (cutActive && cutMax > cutMin) {
          uniforms.uCutX.value.set(cutMin * dpr, cutMax * dpr);
        } else {
          uniforms.uCutX.value.set(0, 0);
        }
      }

      function onDown (e) {
        if (cutFrozen) return;
        if (healRaf) { cancelAnimationFrame(healRaf); healRaf = 0; }
        e.preventDefault();
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        cutMin = 0; cutMax = 0; cutActive = false;
        longPressFired = false;
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = setTimeout(fireLongPress, 1500);
        logoImg.style.cursor = 'grabbing';
        logoImg.style.transition = 'none';
        if (logoImg.setPointerCapture && e.pointerId != null) {
          try { logoImg.setPointerCapture(e.pointerId); } catch (err) {}
        }
      }

      function onMove (e) {
        if (!dragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        // Cancel pending long-press the moment the user starts dragging.
        if (longPressTimer && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
          clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
        logoImg.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';

        var rRect = root.getBoundingClientRect();
        if (e.clientY >= rRect.top && e.clientY <= rRect.bottom) {
          var relX = e.clientX - rRect.left;
          if (!cutActive) {
            cutActive = true;
            cutMin = relX; cutMax = relX;
          } else {
            if (relX < cutMin) cutMin = relX;
            if (relX > cutMax) cutMax = relX;
          }
          pushCut();
        }
      }

      function onUp (e) {
        if (!dragging) return;
        dragging = false;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
        if (logoImg.releasePointerCapture && e && e.pointerId != null) {
          try { logoImg.releasePointerCapture(e.pointerId); } catch (err) {}
        }

        var rRect = root.getBoundingClientRect();
        var coverage = cutActive ? (cutMax - cutMin) / Math.max(1, rRect.width) : 0;
        var snap = 'transform 0.4s cubic-bezier(.2,.7,.2,1)';
        logoImg.style.transition = snap;
        logoImg.style.transform = 'translate(0, 0)';

        if (coverage >= 0.7) {
          // Freeze — pin the cut at full width and lock the affordance off.
          cutFrozen = true;
          cutMin = 0; cutMax = rRect.width; cutActive = true;
          pushCut();
          logoImg.style.cursor = 'default';
        } else {
          // Heal — animate the cut range back to nothing over ~500ms.
          var sMin = cutMin, sMax = cutMax;
          var t0 = performance.now();
          (function step (now) {
            var t = Math.min(1, ((now || performance.now()) - t0) / 500);
            var k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            cutMin = sMin * (1 - k);
            cutMax = sMax * (1 - k);
            pushCut();
            if (t < 1) healRaf = requestAnimationFrame(step);
            else { cutActive = false; cutMin = 0; cutMax = 0; pushCut(); healRaf = 0; }
          })(performance.now());
          logoImg.style.cursor = 'grab';
        }
      }

      logoImg.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    })();
  }

  // =====================================================================
  // Animation loop
  // =====================================================================

  var startMs = performance.now();
  var lastFrame = startMs;
  var rafId = 0;
  // Two independent reasons to pause: the tab being hidden and the rain
  // root being scrolled offscreen. We start the animation loop only when
  // both are "running"; either flipping false stops it. Combining them
  // keeps the pause logic centralised — no race between the two paths.
  var tabActive = !document.hidden;
  var inViewport = true;

  function isRunning () { return tabActive && inViewport; }

  function tick (now) {
    if (!isRunning()) return;
    var dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp to avoid huge jumps
    lastFrame = now;

    uniforms.uTime.value = (now - startMs) / 1000;

    maybeTrickle(dt);
    updateParticles(dt);

    renderer.render(scene, camera);
    drawParticles();

    rafId = requestAnimationFrame(tick);
  }

  function resume () {
    if (rafId) return;            // already running
    lastFrame = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function pause () {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  document.addEventListener('visibilitychange', function () {
    tabActive = !document.hidden;
    if (isRunning()) resume(); else pause();
  });

  // IntersectionObserver — pauses each rain instance when its root
  // scrolls out of the viewport. The hero takes ~100% of the first
  // viewport, so this kicks in on long scrolls; the footer rain is
  // tiny and likely visible only briefly. Saves CPU + GPU on both.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(function (entries) {
      // Only one entry — we observe the rain root itself.
      inViewport = entries[0].isIntersecting;
      if (isRunning()) resume(); else pause();
    }, { rootMargin: '0px', threshold: 0 }).observe(root);
  }

  rafId = requestAnimationFrame(tick);

  // Expose this instance to easter eggs that work across instances
  // (Konami remix, spell-once). Hero is identified by being a
  // descendant of <header.hero>, footer by carrying .footer-rain.
  rainInstances.push({
    root: root,
    uniforms: uniforms,
    isHero: !!(root.closest && root.closest('.hero')),
    isFooter: root.classList.contains('footer-rain')
  });

  } // end setupRain

  // Bootstrap every rain root on the page — currently the hero, plus a
  // thin band below the footer credit row.
  var roots = document.querySelectorAll('[data-hero-rain]');
  for (var i = 0; i < roots.length; i++) setupRain(roots[i]);

  // ===================================================================
  // Easter eggs — operate across all rain instances via the registry.
  // Each function gates itself; failures are silent.
  // ===================================================================

  // 1. Console greeting — anyone who opens DevTools sees a small note.
  (function consoleGreeting () {
    if (!window.console || !console.log) return;
    var title = 'color:#30D158;font-weight:700;font-family:ui-monospace,monospace;font-size:14px;';
    var muted = 'color:#94A3B8;font-family:ui-monospace,monospace;font-size:12px;';
    var hint  = 'color:#166534;font-family:ui-monospace,monospace;font-size:12px;';
    console.log('%cprivacykey', title);
    console.log('%copen-source privacy tools — github.com/privacykey', muted);
    console.log('%cwe hide our easter eggs in the rain. drag the logo. type up-up-down-down…', hint);
  })();

  // 2. Konami remix mode — three-state cycle through the privacykey
  //    family palettes. Each press of the sequence advances:
  //       privacykey green → privacycommand indigo → privacytracker blue
  //       → back to green. The rain colour uniforms swap, and a body
  //       class swaps so .btn-primary picks up the matching tone too.
  //    Esc takes you straight back to green.
  (function konami () {
    var SEQ = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
               'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
               'KeyB', 'KeyA'];
    var pos = 0;
    var stateIdx = 0;
    var STATES = [
      // 0 — privacykey (default green). No body class; btn-primary uses
      //     the existing --green-deep palette.
      {
        name: 'green',
        bodyClass: '',
        consoleColor: '#30D158',
        rainPal: { mid: [0.188, 0.820, 0.345], head: [0.525, 0.937, 0.675], dark: [0.086, 0.396, 0.204] }
      },
      // 1 — privacycommand indigo. body.remix-indigo overrides .btn-primary.
      {
        name: 'indigo (privacycommand)',
        bodyClass: 'remix-indigo',
        consoleColor: '#A5B4FC',
        rainPal: { mid: [0.310, 0.275, 0.898], head: [0.647, 0.706, 0.988], dark: [0.118, 0.106, 0.294] }
      },
      // 2 — privacytracker blue. body.remix-tracker overrides .btn-primary.
      //     Reserved for once privacytracker is back on the landing page.
      {
        name: 'blue (privacytracker)',
        bodyClass: 'remix-tracker',
        consoleColor: '#5fb0ff',
        rainPal: { mid: [0.039, 0.518, 1.000], head: [0.373, 0.694, 1.000], dark: [0.118, 0.227, 0.541] }
      }
    ];

    function applyState (s) {
      rainInstances.forEach(function (inst) {
        inst.uniforms.uColorGreen.value.set(s.rainPal.mid[0], s.rainPal.mid[1], s.rainPal.mid[2]);
        inst.uniforms.uColorGreenHead.value.set(s.rainPal.head[0], s.rainPal.head[1], s.rainPal.head[2]);
        inst.uniforms.uColorDarkGreen.value.set(s.rainPal.dark[0], s.rainPal.dark[1], s.rainPal.dark[2]);
      });
      document.body.classList.remove('remix-indigo', 'remix-tracker');
      if (s.bodyClass) document.body.classList.add(s.bodyClass);
    }

    function logState (s, idx) {
      if (!window.console) return;
      var label = (idx === 0)
        ? '[privacykey] remix off'
        : '[privacykey] remix ' + s.name + ' — Esc to revert';
      console.log('%c' + label, 'color:' + s.consoleColor);
    }

    window.addEventListener('keydown', function (e) {
      if (e.code === 'Escape' && stateIdx !== 0) {
        stateIdx = 0;
        applyState(STATES[0]);
        logState(STATES[0], 0);
        return;
      }
      if (e.code === SEQ[pos]) {
        pos++;
        if (pos === SEQ.length) {
          pos = 0;
          stateIdx = (stateIdx + 1) % STATES.length;
          applyState(STATES[stateIdx]);
          logState(STATES[stateIdx], stateIdx);
        }
      } else {
        // Allow re-starting the sequence if the current key matches its first step.
        pos = (e.code === SEQ[0]) ? 1 : 0;
      }
    });
  })();

  // 3. Triple-click "privacy" in the headline — eases the doubling rect
  //    out to the whole hero canvas, holds, then eases it back. The
  //    transitions on either side stop the flood from feeling like a
  //    hard switch.
  (function tripleClickPrivacy () {
    var hero = null;
    for (var i = 0; i < rainInstances.length; i++) {
      if (rainInstances[i].isHero) { hero = rainInstances[i]; break; }
    }
    if (!hero) return;
    var word = document.querySelector('.word-privacy');
    if (!word) return;

    var clicks = [];
    var animRaf = 0;
    var revertTimer = 0;
    var savedRect = null;             // baseline rect to return to
    var EXPAND_MS = 700;
    var HOLD_MS = 3600;
    var CONTRACT_MS = 800;

    function easeInOut (t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function lerpVec4 (u, from, to, duration, done) {
      if (animRaf) cancelAnimationFrame(animRaf);
      var t0 = performance.now();
      (function step () {
        var t = Math.min(1, (performance.now() - t0) / duration);
        var k = easeInOut(t);
        u.set(
          from.x + (to.x - from.x) * k,
          from.y + (to.y - from.y) * k,
          from.z + (to.z - from.z) * k,
          from.w + (to.w - from.w) * k
        );
        if (t < 1) animRaf = requestAnimationFrame(step);
        else { animRaf = 0; if (done) done(); }
      })();
    }

    word.addEventListener('click', function () {
      var now = performance.now();
      clicks = clicks.filter(function (t) { return now - t < 700; });
      clicks.push(now);
      if (clicks.length < 3) return;
      clicks = [];

      var u = hero.uniforms.uDouble.value;
      // Capture the baseline only on the first trigger so re-triggers
      // mid-flood don't capture the already-expanded rect as "home".
      if (!savedRect) savedRect = u.clone();

      var res = hero.uniforms.uResolution.value;
      var fullRect = new THREE.Vector4(0, 0, res.x, res.y);
      var startRect = u.clone();

      // Cancel any pending revert — re-triggers extend the flood.
      if (revertTimer) { clearTimeout(revertTimer); revertTimer = 0; }

      // Expand: ease from current rect out to the whole canvas.
      lerpVec4(u, startRect, fullRect, EXPAND_MS, function () {
        // Hold at full canvas, then ease back to the saved baseline.
        revertTimer = setTimeout(function () {
          revertTimer = 0;
          lerpVec4(u, u.clone(), savedRect, CONTRACT_MS, function () {
            savedRect = null;       // ready for the next trigger
          });
        }, HOLD_MS);
      });
    });
  })();

  // 4. Spell once — 120-180s after page load, animate uSpellAmount up so
  //    only "PRIVACY KEY" mask pixels stay lit, then back to normal.
  (function spellOnce () {
    if (!rainInstances.length) return;
    var fireDelay = 120000 + Math.random() * 60000;
    setTimeout(function () {
      var t0 = performance.now();
      var IN = 900, HOLD = 1800, OUT = 1300, TOTAL = IN + HOLD + OUT;
      function ease (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
      function step () {
        var t = performance.now() - t0;
        var raw;
        if (t < IN)              raw = t / IN;
        else if (t < IN + HOLD)  raw = 1;
        else if (t < TOTAL)      raw = 1 - (t - IN - HOLD) / OUT;
        else                     raw = 0;
        var v = ease(Math.max(0, Math.min(1, raw)));
        rainInstances.forEach(function (inst) { inst.uniforms.uSpellAmount.value = v; });
        if (t < TOTAL) requestAnimationFrame(step);
        else rainInstances.forEach(function (inst) { inst.uniforms.uSpellAmount.value = 0; });
      }
      requestAnimationFrame(step);
    }, fireDelay);
  })();
})();
