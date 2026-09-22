# Tests

All three suites drive a real headless Chromium (Playwright, WebGL via
SwiftShader) against a running server. Start one first:

```sh
npm run dev          # then: npm test
```

or, to test what actually ships:

```sh
npm run build && npm run preview
node test/links.mjs  http://localhost:4173/?debug
node test/smoke.mjs  http://localhost:4173/?debug
node test/remote.mjs http://localhost:4173/?debug
```

The `?debug` is needed against a production build: `src/main.js` only exposes
`window.__viewer` in dev, or when that query parameter is present.

| Suite | What it covers | Network |
|---|---|---|
| `links.mjs` | Drive id extraction from every share-link shape; Dropbox/GitHub rewriting; filename parsing. Pure logic, run in-page so Vite resolves `import.meta.env`. | no |
| `smoke.mjs` | The app boots with no console errors; model loads and is framed; every light slider changes rendered pixels; shadows render and track the sun; the loop idles at rest and wakes on interaction; nothing leaks across reloads; screenshots encode. | no |
| `remote.mjs` | Four real models over the network, including a Draco-compressed `.gltf` with external `.bin` and textures. Plus the failure paths: 404, CORS rejection, malformed URL, unconfigured Drive. | yes |
| `inspect.mjs` | Not a test — renders the model in several orientation states to `artifacts/*.png` and dumps scene state. For eyeballing a change. | no |
| `errors.mjs` | Not a test — prints whatever the page logs or throws on load, and checks the canvas is not stuck in a resize loop. First thing to run when something breaks. | no |

`smoke.mjs` writes `artifacts/viewport.png` on every run. Keep a copy before a
change that should not alter the image, and compare afterwards to catch
lighting or colour-space drift.

## Run the suites sequentially, with a pause

`npm test` runs them one after another, and that is required rather than
preferred. Two concurrent headless Chromium instances contend for the software
rasterizer hard enough to fail timing-sensitive checks.

Even sequentially, eight real browser sessions back to back can exhaust this
environment: a batch run failed on `render` and `materials` while both passed
standalone (80/80 and 35/35), and the same batch with a three-second pause
between suites passed all eight - 287 checks, zero failures. If a batch fails
on suites that pass alone, that is what is happening; add the pause rather
than hunting for a defect.

The heaviest single pass is pixel sort, whose shader takes around five seconds
to compile under SwiftShader.

## Why not Playwright screenshots

Image comparisons hash the output of the viewer's own `captureScreenshot()`,
not `page.screenshot()` or `locator.screenshot()`.

Both Playwright paths drive Chromium's compositor capture, which under software
rendering (SwiftShader) intermittently never returns for a WebGL canvas fed by
an on-demand `setAnimationLoop` — the capture waits for a frame commit that a
deliberately idle render loop has no reason to produce. It manifests as a
30-second timeout partway through a run.

`captureScreenshot()` renders and reads back inside a single synchronous task,
which is exactly the guarantee needed, and has the side benefit that these
assertions exercise the same code path the Screenshot button uses.

## Why the turntable test doesn't assert on video content

`canvas.captureStream()` + `MediaRecorder` produce no real frame data under
headless Chromium + SwiftShader software rendering — confirmed with a
standalone repro (captureStream + MediaRecorder, zero app code involved) that
delivered exactly one empty `dataavailable` event over a window that should
have produced several, unaffected by `--headless=new` or autoplay-policy
flags. This is the same class of headless-testing limitation as the
screenshot one above, just for video instead of a single frame.

`test/render.mjs` still hard-checks what doesn't depend on the browser's media
pipeline cooperating — the render-loop hold during recording, and the model's
rotation and the hold both being restored afterward — and reports whether real
frame data came through as a diagnostic line rather than a pass/fail gate, so
a genuine regression is still visible without failing the suite on something
this environment cannot exercise. Verify actual video output (a real,
seamlessly-looping WebM) manually in a real browser.

## Why pixel comparisons

Several checks assert that moving a control *changes the rendered image* rather
than that a property was set. That is deliberate. The bug that made two of the
six lighting sliders useless (`RectAreaLightUniformsLib.init()` was never
called) would pass any assertion about `light.intensity` — the value was set
correctly, it just never reached the screen. Only comparing pixels catches it.

## Known-slow cases

`remote.mjs` fetches from `raw.githubusercontent.com`; a cold run takes about a
minute. Each in-page step has a 90-second deadline, because a loader that never
calls `onLoad` or `onError` otherwise hangs the run indefinitely — which is
exactly what a broken Draco decoder did before `optimizeDeps.exclude` was added
to `vite.config.js`.
