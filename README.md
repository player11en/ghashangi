# 3D Model Studio

Load a 3D model in the browser, make it look good, and get publishable images
out of it.

Drop a `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl` or `.usd` file — or paste a
Google Drive share link — then fix its orientation, recolour its materials, tune
the lighting, and export a PNG per colour variant.

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

**Output**
- **Colourways**: save named material sets, switch between them, and export one
  PNG per colourway as a zip
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
    materials.js    per-material editing, snapshot and reset
    colorways.js    named material sets, batch PNG zip, GLB export
    lights.js       the light rig and the shadow catcher
    environment.js  PMREM environment, background, tone mapping
    dispose.js      recursive GPU resource disposal
  loaders/          format dispatch, lazy decoders, multi-file resolution
  sources/          file/drag-drop, URL, Google Drive
  ui/               toasts, progress, the materials panel
styles/main.css     tokens, panel, controls; light and dark
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

Individual suites: `test:links`, `test:smoke`, `test:stats`, `test:materials`,
`test:remote`. Diagnostics: `test:errors`, `test:inspect`, `test:ui`.
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

## Known gaps

- **No AR.** Not built. WebXR hit-test and iOS Quick Look are both planned but
  unstarted.
- **No animation controls yet.** A model's first clip autoplays; there is no
  clip list, scrub or speed control.
- **Only colourways persist.** Lighting, orientation and camera reset on reload.
- **Assets are uncompressed.** The 4.3 MB demo model and 1.5 MB HDR both load
  eagerly; Draco/KTX2 and an UltraHDR environment would cut that substantially.
- `dist/assets/` carries about 1.9 MB of Draco and Basis decoder variants
  because Vite emits every `new URL(…, import.meta.url)` in three's loaders.
  Only ~340 KB is ever fetched at runtime, so this costs deploy size, not user
  bandwidth.

## Credits

Built on [three.js](https://threejs.org) r186. Test models from the
[glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
repository.
