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
| `inspect.mjs` | Not a test — dumps scene state and writes `artifacts/stage-on.png` / `stage-off.png`. For eyeballing a change. | no |

`smoke.mjs` writes `artifacts/viewport.png` on every run. Keep a copy before a
change that should not alter the image, and compare afterwards to catch
lighting or colour-space drift.

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
