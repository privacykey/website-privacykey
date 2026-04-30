# Vendored libraries

Self-hosted third-party JavaScript shipped with the site. The browser only
ever talks to our own origin for these — no CDN call, no cross-origin
request.

## What's here

- `three.min.js` — [Three.js](https://threejs.org) v0.160.0, the WebGL
  library that powers the binary-rain shader in `assets/hero-rain.js`.
- `three.LICENSE` — the MIT licence text that accompanies the file.
  Three.js is MIT-licensed; redistributing the minified build with the
  licence preserved is explicitly permitted by the licence terms.

The licence is also surfaced on the public **/legal** page so anyone
auditing the org's compliance has a single place to read it.

## Updating Three.js

```sh
# Pull the version you want from npm (registry tarball, not jsDelivr —
# avoids any DNS dependency on the CDN).
VERSION=0.160.0
curl -sL -o /tmp/three.tgz \
  "https://registry.npmjs.org/three/-/three-${VERSION}.tgz"

# Extract just the build + licence; throw the rest away.
mkdir -p /tmp/three-extract && cd /tmp/three-extract
tar -xzf /tmp/three.tgz package/build/three.min.js package/LICENSE

# Drop into place.
cp /tmp/three-extract/package/build/three.min.js   assets/vendor/three.min.js
cp /tmp/three-extract/package/LICENSE              assets/vendor/three.LICENSE
```

If you bump versions, also update the version string mentioned on `/legal`
and in the `<!-- Three.js -->` comment above the `<script>` tag in each
locale's `index.html`.

## Why self-host?

Three reasons:

1. **One origin, one trust boundary.** The site advertises that it doesn't
   send your data anywhere — that claim is hard to make if a third-party
   CDN is in the request chain.
2. **Offline reliability.** No DNS lookup against a third-party host means
   one less reason for the page to break.
3. **CSP simplicity.** With everything same-origin, `script-src` reduces
   to `'self'` (plus the analytics endpoint). No allowlist juggling.

## Subresource Integrity (SRI)?

Not needed for same-origin scripts — SRI exists to verify cross-origin
bytes haven't been tampered with by a CDN. When you serve the file
yourself, the same `'self'` policy that protects every other asset
covers `three.min.js`.

If you do switch back to a CDN at some point, the canonical jsDelivr
URL is `https://cdn.jsdelivr.net/npm/three@<version>/build/three.min.js`
and the SHA-384 for v0.160.0 is published on the package page at
<https://www.jsdelivr.com/package/npm/three?path=build>.

## Fonts

Self-hosted fonts (Inter, JetBrains Mono, Noto Sans SC) live separately
under `/assets/fonts/`. Same posture as Three.js — origin-only, licence
text bundled per family, surfaced on `/legal`. To update them, pull the
matching `@fontsource[-variable]/<family>` package from npm and copy
the woff2 + LICENSE files across.
