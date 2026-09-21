# 3D Model Studio

Load a 3D model in the browser, make it look good, and get publishable images
and clips out of it. No install, no account, no upload — it opens and it works.

Drop a `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl` or `.usd` file — or paste a
Google Drive share link — then fix its orientation, recolour its materials, tune
the lighting, style it, and export a PNG per colour variant or a camera-move
clip.

```sh
npm install
npm run dev          # http://localhost:5173
```

## What it is for

Most browser model viewers are **inspectors**: they tell you what is inside a
file. This one is a **studio**: it helps you produce a picture of it.

> A shop has one sneaker GLB and needs six product shots, one per colourway, on
> a transparent background at 2000px.
>
> Normally that means opening Blender, recolouring, rendering, and repeating six
> times. Here: drop the GLB, pick a material, set a colour, save it as "Red",
> repeat, then **Export PNGs** — six images in a zip.

The same engine also does the opposite of clean product work: a stack of
reorderable stylization passes (CRT, film, retro palettes, ASCII, halftone,
glitch) over a recordable camera move, for stylized clips rather than accurate
ones. One app, one panel — a correctly-lit, correctly-framed scene is the right
starting point for both.

If you want a glTF validation report or a scene-graph debugger, use
[glTF Viewer](https://gltf-viewer.donmccurdy.com) or the
[Babylon Sandbox](https://sandbox.babylonjs.com) instead. They do that better,
and this app deliberately does not compete there.

## Features

**Loading**
- Drag and drop a file, a multi-file set, or a whole folder
- `.glb` `.gltf` `.fbx` `.obj` `.stl` `.usdz` `.usda` `.usdc` `.usd`
- Draco, KTX2 and Meshopt compressed glTF
- Google Drive share links, Dropbox, GitHub, or any direct URL
- Real progress, and errors that say what to do about them

**Studio**
- Up-axis presets (Y/Z/X) — one click fixes a model that loaded on its side
- Per-axis rotation, with ±90° snaps, always re-grounded onto the floor
- Per-material colour with a **blend** dial that tints a textured model rather
  than flattening it
- Metalness, roughness, emissive, glow, opacity — only the channels a material
  actually has
- Cyclorama backdrop, a five-light rig, shadows, AgX/ACES/Neutral tone mapping,
  HDR environment with rotation and intensity
- **Ambient occlusion** (GTAO) and antialiasing (SMAA) — contact darkening is
  what makes a product read as sitting on the backdrop rather than pasted onto
  it. Off by default; the passes are only downloaded if you turn them on
- **Depth of field** — focus distance, aperture and max blur, with focus seeded
  from the subject's own size so it starts usefully focused instead of needing
  three slider hunts
- Undo/redo for material edits (`Ctrl+Z` / `Ctrl+Shift+Z`); a slider drag
  coalesces into one step rather than hundreds
- Animation: clip list, play/pause, scrub, speed, loop
- A Quality tier auto-picked from the device, and overridable — a wrong guess
  costs one dropdown change, never a locked-in bad experience

**Style**

Twelve stylization effects, each one pass, all optional and all lazily loaded:

- **CRT** — barrel curvature, scanlines, aperture mask, chromatic aberration,
  halation, vignette, grain, analog jitter. Presets plus raw sliders
- **Film** — Super8 / clean 16mm / trashed: grain, dust, gate weave, light
  leak, warmth
- **Retro palette** — pixelation, real fixed palettes (GBC / Genesis / Atari)
  and 4×4 Bayer ordered dithering
- **ASCII** — a real font-atlas shader pass, so it composites and records like
  any other effect (the usual DOM-`<table>` approach cannot be captured)
- **Halftone** — dot matrix, CMYK separation at proper screen angles, linocut
- **Bloom**, **Glitch**, **Afterimage/trails**
- **Colour grade** — brightness/contrast/saturation/hue, plus duotone, hue
  cycle and thermal rainbow
- **Tone** — posterize, solarize, Sobel edges
- **Repeat** — mirror, kaleidoscope, tile
- **Displace** — wave, wobble, jitter, shake

The chain order is **reorderable** — CRT-then-bloom and bloom-then-CRT are
genuinely different images — and the order persists.

**Output**
- **Camera path**: place waypoints at views you like, then record the move as a
  clip. Aspect lock (Free / 9:16 / 1:1) so a clip comes out the shape the
  platform wants. Style effects are in the recording automatically, because the
  composer writes to the same canvas `captureStream()` reads
- **Colourways**: save named material sets, switch between them, and export one
  PNG per colourway as a zip
- **Turntable**: record a seamless-looping WebM of the model rotating
- Screenshots up to 4×, with an optional transparent background
- GLB export with material edits and the orientation fix baked in

## Google Drive setup

Optional. Without it, file, URL, Dropbox and GitHub loading all still work and
the Drive hint says so.

1. In [Google Cloud Console](https://console.cloud.google.com), enable the
   **Google Drive API**
2. Create an **API key** under *APIs & Services → Credentials*
3. Restrict it — this is the part that matters:
   - *API restrictions*: **Google Drive API** only
   - *Application restrictions*: **Websites**, listing your deployment origins
     plus `http://localhost:5173` for local development
4. `cp .env.example .env.local` and set `VITE_GOOGLE_API_KEY`

> **The key is public.** Vite inlines every `VITE_*` variable into the built
> JavaScript, so anyone can read it out of a deployed bundle. Keeping it out of
> git is hygiene, not a security boundary — the referrer and API restrictions in
> step 3 are the actual control. With both in place, a leaked key can only do
> what the app already does: read files that are already shared publicly, from
> your own origins.

Only files shared as **"Anyone with the link"** can be opened. Private files
would need OAuth and the Google Picker, which is not implemented.

Note also that `drive.google.com/uc?export=download` — the link most guides
suggest — answers `403` with no CORS headers and cannot be used from a browser
at all. The app goes through the Drive API's `alt=media` endpoint instead, which
does send CORS headers and exposes `Content-Length`, so progress is real.

## Project layout

```
index.html          the shell; all controls live in one scrolling panel
src/
  main.js           bootstrap: build the viewer, wire controls and sources
  core/
    viewer.js       renderer, scene, camera, controls, the model slot
    render-loop.js  one on-demand loop — renders only when something changes
    frame.js        bounds -> normalise, ground, frame the camera
    orientation.js  up-axis presets and per-axis rotation
    animation.js    clip playback, scrub, speed
    materials.js    per-material editing, snapshot and reset
    material-undo.js  undo/redo over material state, debounced
    colorways.js    named material sets, batch PNG zip, GLB export
    lights.js       the light rig and the shadow catcher
    environment.js  PMREM environment, background, tone mapping
    post.js         the composer: AO, AA, DOF, and the reorderable Style chain
    passes/         one file per stylization pass (crt, film, palette, ascii, …)
    recorder.js     generic canvas -> WebM clip recording
    turntable.js    a thin rotation wrapper over recorder.js
    camera-path.js  waypoints, preview, playback, clip recording
    capability.js   device tier probe (low / medium / high)
    simplify.js     triangle budget for dense models
    settings.js     localStorage persistence for every control
    telemetry.js    local-only usage counters, never sent anywhere
    dispose.js      recursive GPU resource disposal
  loaders/          format dispatch, lazy decoders, multi-file resolution
  sources/          file/drag-drop, URL, Google Drive
  ui/               toasts, progress, panels, accordion, aspect lock
styles/main.css     tokens, panel, controls; light and dark
scripts/            static audits (check-refs, check-dom-ids), asset compression
assets-src/         pristine source assets, NOT shipped — see scripts/
test/               browser tests, see test/README.md
```

### Two structural ideas worth knowing

**On-demand rendering.** `render-loop.js` registers `setAnimationLoop` exactly
once and draws only when something invalidates the view. An idle viewer renders
zero frames per second. Any setter that changes the image has to call
`invalidate()`, or the change will not appear.

**Three nested transforms**, each owned by exactly one thing so none can
overwrite another:

```
modelRoot      user scale + height, and the auto-rotate spin
  orientRoot   user X/Y/Z orientation, re-grounded after every change
    object     the normalisation scale baked in by frame.js
```

Collapsing these onto one object is what made the original's scale slider
overwrite its own auto-fit, and it is why auto-rotate cannot share a rotation
channel with the orientation controls.

## Testing

Browser tests driving real Chromium via Playwright. Start a server first:

```sh
npm run dev
npm test
```

Individual suites: `test:links`, `test:smoke`, `test:stats`, `test:animation`,
`test:render`, `test:materials`, `test:camera-path`, `test:remote`.
Diagnostics: `test:errors`, `test:inspect`, `test:ui`.

Run the suites **sequentially**, which is what `npm test` does. Two concurrent
headless Chromium instances contend for the software rasterizer hard enough to
fail timing-sensitive checks, which cost real time to chase twice before the
cause was clear.

`npm run check` runs two static passes, both before every build:

- **Unresolved identifiers.** Rollup treats a free identifier as a global rather
  than an error, so a missing import builds cleanly and throws at runtime.
- **DOM ids.** Every `$('id')` and `getElementById('id')` in `src/` is checked
  against `index.html`, so a renamed element fails the build instead of
  producing a silently dead control.
See [test/README.md](test/README.md) for what each covers and why image
comparisons avoid Playwright's screenshot API.

## Building

```sh
npm run build        # -> dist/, deployable to any static host
npm run preview
```

`base` is relative, so `dist/` works from a subpath (GitHub Pages, a CDN folder)
as well as from a domain root.

For WebXR or device testing over the LAN, `npm run dev:https` adds a self-signed
certificate — a secure context is required.

Sourcemaps are **off** by default. They were 5.5 MB of a 15 MB `dist/` — a third
of the upload, fetched only when devtools is open. `npm run build:maps` emits
them when a production stack trace actually needs tracing back to source.

## Deploying to shared hosting

Upload the **contents of `dist/`**, and nothing else. The app is fully static:
no Node process, no database, no build step on the server.

```sh
npm run build
# then upload everything inside dist/ into public_html/ (or a subfolder)
```

What the host has to do, and what it doesn't:

- **A subfolder is fine.** `base: './'` in `vite.config.js` is relative, so
  `example.com/viewer/` works with no config change.
- **No `.htaccess` rewrites.** One page, no client-side routing — nothing to
  rewrite.
- **`.wasm` must be served as `application/wasm`.** The Draco and KTX2 decoders
  are WebAssembly, and some shared hosts still don't know that MIME type. If a
  compressed model fails to load while an uncompressed one works, check this
  first. On Apache: `AddType application/wasm .wasm`.
- **Turn on gzip or brotli for `.js`** if the host offers it. It is the single
  biggest difference on a slow connection — see the table below.
- **`VITE_GOOGLE_API_KEY` is baked into the bundle** at build time and is public
  by design (see [Google Drive setup](#google-drive-setup)). Restricting it by
  HTTP referrer in Google Cloud Console is the security boundary, not secrecy.
  Leaving it unset just disables Drive loading; file and URL loading keep
  working.

Measured on the current build:

| What | On disk | Over the wire | Blocks first model? |
|---|---|---|---|
| `index.html` | 40 KB | ~8 KB gzipped | yes |
| app JS | 431 KB | ~163 KB gzipped | yes |
| three.js chunk | 613 KB | ~155 KB gzipped | yes |
| `model/RTX3090Ti.glb` | 1.02 MB | 1.02 MB (already compressed) | yes |
| `Skybox/*.hdr` | 1.5 MB | 1.5 MB | **no** — a procedural studio environment lights the first frame and the HDR swaps in afterwards |
| everything else in `dist/` | ~2.3 MB | — | no — per-format loaders and decoder variants, fetched only when a file needs them |
| **`dist/` total** | **5.9 MB** | — | — |

So a first visit is roughly **1.4 MB** with compression on, against the 2 MB
target this project set itself at the start. The demo model is the bulk of it;
`npm run assets` is what got it there — see
[`scripts/compress-assets.mjs`](scripts/compress-assets.mjs) for why textures,
not geometry, were the thing to compress.

## Known gaps

- **No AR.** Not built. WebXR hit-test and iOS Quick Look are both planned but
  unstarted.
- **Turntables cannot be transparent.** WebM does not carry alpha reliably
  across players. Use the colourway PNG export if you need an alpha channel.
- **Camera position does not persist.** 77 settings do (lighting, tone mapping,
  environment, AO/AA/DOF, every Style effect and its chain order, up-axis, open
  accordion sections) — camera is deliberately excluded, because `frameCamera()`
  already computes a correct camera for whatever model loads next and a stale
  saved position would fight it. Fine per-model rotation is excluded for the
  same reason.
- **The HDR environment is still 1.5 MB.** It is non-blocking — a procedural
  studio environment lights the first frame — so it costs background bandwidth,
  not time-to-first-model. An UltraHDR or KTX2 environment would cut it ~5×.
- `dist/assets/` carries about 1.9 MB of Draco and Basis decoder variants
  because Vite emits every `new URL(…, import.meta.url)` in three's loaders.
  Only ~340 KB is ever fetched at runtime, so this costs deploy size, not user
  bandwidth.

## Contributing

Bug reports and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for
setup, the test suite, and what kind of changes fit this project's scope.

## Credits

Built on [three.js](https://threejs.org) r186. Test models from the
[glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
repository.

## License

[MIT](LICENSE).
