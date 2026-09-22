# Contributing

Thanks for looking at this. It's a small project, so this file is short.

## Setup

```sh
npm install
npm run dev          # http://localhost:5173
```

## Before opening a PR

```sh
npm run check        # static audits — unresolved imports, dead DOM ids
npm run build         # must complete clean
npm run dev            # in one terminal, then in another:
npm test               # full browser suite via Playwright
```

Run the suites **sequentially** (`npm test` already does). Two concurrent
headless Chromium instances contend for the software rasterizer hard enough
to produce false failures — confirmed the hard way, twice, before that
became a rule.

If you only touched one area, the matching individual suite is faster to
iterate on: `test:links`, `test:smoke`, `test:stats`, `test:animation`,
`test:render`, `test:materials`, `test:camera-path`, `test:remote`. Run the
full `npm test` before opening the PR regardless — see
[test/README.md](test/README.md) for what each suite actually covers.

## What is worth working on

[ROADMAP.md](ROADMAP.md) lists the planned phases, the known gaps, and what is
deliberately out of scope with the reasoning for each. Reading its "Not
planned" table before starting something substantial will save you the most
time.

## What kind of changes fit here

This is one app, one engine, one control panel — not two products behind a
mode switch. A few things that follow from that, checked in review:

- **New render settings must default to off / today's behavior.** Every
  toggle added so far falls back to the exact pre-existing image when
  disabled, verified by a pixel-comparison test (`test/render.mjs` has many
  examples — "toggling X off restores the original image exactly"). A
  feature that can't degrade cleanly needs a real conversation first, not
  just a PR.
- **Render-affecting state needs `invalidate()`.** The render loop is
  on-demand (0 fps at rest by design) — any setter that changes the image
  has to call the injected `invalidate()` or the change silently won't
  appear until something unrelated (like orbiting the camera) happens to
  redraw. `src/core/render-loop.js` and the pattern in `src/core/post.js`
  are the reference.
- **No new top-level UI surface without discussion first.** A second panel,
  a mode toggle, a second app shell — these are explicitly out of scope
  right now (see the project's own planning notes if you want the reasoning
  in full). A new accordion section for a genuinely new feature is fine; a
  structural change to the panel itself is a bigger conversation than most
  PRs.
- **Match what's already there.** New stylization passes follow the
  existing "one `ShaderPass`, one enable toggle, a mode dropdown for
  variants" shape (`src/core/passes/*.js`) rather than inventing a new
  pattern per effect.

## Reporting bugs

Include the browser/OS, and if it's rendering-related, whatever
`window.__viewer` reports is useful — device tier, whether AO/Style effects
were on, console errors. A screenshot or short clip of the actual visual
problem is worth more than a description of it.

## License

By contributing, you agree your contribution is licensed under this
project's [MIT license](LICENSE).
