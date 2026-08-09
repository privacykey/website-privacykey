# website-privacykey

The privacykey organisation site — live at [privacykey.org](https://privacykey.org/).

[![Project status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fprivacykey%2F.github%2Fmain%2Fbadges%2Fwebsite-privacykey.json)](https://github.com/privacykey/.github/blob/main/STATUS.md#website-privacykey) [![Licence](https://img.shields.io/github/license/privacykey/website-privacykey?label=licence)](LICENSE)

<!-- disclosure:start -->
> [!WARNING]
> **Project status.** The badge above is generated from [the privacykey status list](https://github.com/privacykey/.github/blob/main/STATUS.md), which says what I promise for this project and every other one.
<!-- disclosure:end -->

---

This site markets the privacykey family as a whole rather than a single product. The landing page states the org's four values and links the tools that have shipped so far:

- [privacytracker](https://github.com/privacykey/privacytracker)
- [privacycommand](https://github.com/privacykey/privacycommand)

Alongside the landing page the repo carries the org's public policy pages — [privacy](https://privacykey.org/privacy.html), [open](https://privacykey.org/open.html) (the public analytics dashboard) and [legal](https://privacykey.org/legal.html) — plus `robots.txt`, `sitemap.xml`, `llms.txt` and an RFC 9116 `security.txt`.

It is hand-written static HTML, CSS and one JavaScript file. There is no framework, no bundler and no package manifest: what is committed is what is served.

## Run it locally

```sh
just run
```

That is the only recipe in the [`justfile`](justfile); it runs `npx --yes wrangler pages dev .` and serves the repository root. Serving from the root matters — [`site.webmanifest`](site.webmanifest) uses absolute paths (`/en/`), so a server rooted anywhere else will not match production. `just --list` prints the recipes.

## Build and deploy

There is no build step. GitHub Pages serves `main` from the repository root, so merging to `main` is the deploy; the Pages origin is <https://privacykey.github.io/website-privacykey/>. Pages is configured to use [`404.html`](404.html) as the custom 404 page.

The public hostname <https://privacykey.org/> answers through Cloudflare and returns byte-identical content to the Pages origin. No `CNAME` file is committed — the domain is wired up outside this repository.

## Where content and assets live

| Path | What it is |
| --- | --- |
| [`index.html`](index.html) | Root splash. `noindex`; redirects to a locale from `navigator.languages`, with manual links as the no-JS fallback. |
| [`en/index.html`](en/index.html) | The English landing page — hero, values, tools grid. |
| [`privacy.html`](privacy.html), [`open.html`](open.html), [`legal.html`](legal.html) | Policy pages, linked from every page footer. |
| [`assets/site.css`](assets/site.css) | All styling for the site. |
| [`assets/hero-rain.js`](assets/hero-rain.js) | The hero's binary-rain shader and cursor emitter. Bails out under `prefers-reduced-motion` and pauses when the tab is hidden. |
| [`assets/vendor/`](assets/vendor/) | Self-hosted Three.js plus its licence. |
| [`assets/fonts/`](assets/fonts/) | Self-hosted Inter, JetBrains Mono and Noto Sans SC, each with its OFL licence text. |
| [`assets/logos/`](assets/logos/), [`assets/icons/`](assets/icons/), [`assets/social/`](assets/social/) | Brand marks, the favicon and PWA icon family, and the 1200×630 social card. |
| [`llms.txt`](llms.txt) | The preferred entrypoint for agents — kept current by hand when a tool ships. |
| [`robots.txt`](robots.txt), [`sitemap.xml`](sitemap.xml), [`security.txt`](security.txt), [`.well-known/security.txt`](.well-known/security.txt) | Crawler rules, page index and disclosure policy. |

Third-party code is vendored on purpose: the browser only ever talks to this origin, which keeps the Content-Security-Policy in each page's `<head>` tight and keeps the site's own privacy claim honest. [`assets/vendor/README.md`](assets/vendor/README.md) has the steps for updating Three.js and the fonts.

### Locales

Only `en/` exists today. The root redirect, the `hreflang` tags and [`sitemap.xml`](sitemap.xml) all still point at `/zh/` and `/el/`, and both currently return 404 — the nav's language switcher is commented out for that reason. Ship the directories before promoting those paths.

## Licence

Apache-2.0 — see [LICENSE](LICENSE).

The bundled fonts and Three.js keep their own licences (SIL OFL 1.1 and MIT respectively); each ships its licence text next to the files and they are listed on [legal.html](https://privacykey.org/legal.html). Brand assets — the wordmark, the key icon and screenshots — are released under CC BY-NC 4.0, as stated on that same page.
