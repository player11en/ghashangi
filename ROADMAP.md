# Roadmap

What is built, what is next, and what deliberately is not planned.

Status here is honest rather than aspirational: "shipped" means verified in a
real browser by the test suite, not "the code exists". Where something is a
known gap, it says so, and says why it has not been closed yet.

---

## Shipped

| Area | State |
|---|---|
| **Loading** | `.glb` `.gltf` `.fbx` `.obj` `.stl` `.usd*`, multi-file and folder drop, Draco/KTX2/Meshopt, Google Drive links, any CORS URL |
| **Framing** | Auto-normalise, auto-frame, bounds-derived near/far, up-axis presets, per-axis rotation with re-grounding |
| **Materials** | Per-material colour with a texture-preserving blend dial, metalness, roughness, emissive, opacity, undo/redo |
| **Colourways** | Named material sets, per-model persistence, batch PNG export as a zip, GLB export |
| **Lighting** | Five-light rig, shadows, AgX/ACES/Neutral tone mapping, HDR environment with rotation and intensity |
| **Fidelity** | GTAO ambient occlusion, SMAA, depth of field — each lazily loaded, each with a pixel-exact off state |
| **Style** | 12 reorderable stylization passes: CRT, film, retro palette, ASCII, halftone, bloom, glitch, trails, colour grade, tone, repeat, displace |
| **Animation** | Clip list, transport, scrub, speed, loop |
| **Output** | Screenshots to 4x with optional transparency, turntable WebM, camera-path clips with 9:16 / 1:1 aspect lock |
| **Performance** | On-demand rendering (0 fps at rest), device capability tiers, dense-model triangle budget, ~1.4 MB first load |

218 checks across 8 browser suites. See [test/README.md](test/README.md).

---

## Phase 7 — Control gaps and panel overview

Everything here is small, and all of it came out of actually using the app
rather than reading the code.

### Confirmed gaps where the backend is already built

- **Bloom threshold and radius have no UI.** `setBloomThreshold()` and
  `setBloomRadius()` exist in `post.js` and work; neither has a slider. With
  threshold stuck at its 0.7 default, turning the lights up blooms the whole
  frame with no way to say "only the genuinely bright parts". The most
  visible missing control in the app.
- **No global settings reset.** There is Reset Cam, Reset Material and Reset
  Orientation, but nothing returning lighting, Style and fidelity to shipped
  defaults. Recovering from an over-cranked setup means un-toggling by hand
  or clearing site data.
- **Light colours are hardcoded.** The two fill lights are authored blue and
  salmon. No picker for either, or for the sun.
- **Pixelation is welded to the retro palette.** It is a uniform inside
  `palette-pass.js`, so pixelating without also quantizing to a fixed
  palette is impossible. It should switch independently.
- **ASCII is thin on controls** next to every other pass: cell size,
  colourise, invert and the ramp, with no luminance brightness/contrast
  remap and no background colour.
- **The stage has visibility and nothing else.** Show or hide, no colour, no
  roughness, no "just a gradient backdrop" mode.

### Panel overview

Thirteen sections in one scrolling column, with a thirteen-button jump rail
beside it, is past what either pattern carries well — and every item in this
roadmap adds rows. Moving to a **tab bar** that groups the existing sections,
keeping the accordion inside each tab:

| Tab | Sections |
|---|---|
| Model | Load, Model, Orientation, Animation |
| Look | Materials, Colourways, Lighting, Environment, Stage |
| Style | Style (effects and chain order) |
| Output | Capture, Camera Path, Turntable |
| Info | Stats |

The tab bar replaces the jump rail rather than sitting beside it. This is a
layout change inside one app — not a mode switch, not a second shell.

### Style chain drag-and-drop

The up/down buttons stay, for keyboard and screen-reader access. Dragging is
added on top of them.

---

## Phase 8 — Framing and composition feedback

- **Render-frame overlay**, the thing Blender's camera passepartout does: dim
  everything outside the export frame, live, while composing. The current
  aspect lock physically shrinks the viewport, and only during an active
  preview or recording, which is the wrong tool for "where will this crop".
  The overlay is non-destructive: full resolution, full interactivity, guide
  only.
- **Aspect and resolution presets** beyond Free / 9:16 / 1:1 — 4:3, 21:9,
  2:3, custom W:H, with output pixel dimensions stated rather than implied.
- **Camera bookmarks** — front, three-quarter, top, back as one-click views,
  separate from the camera-path animation. Lighter than keyframing for
  someone who wants three consistent angles.

---

## Phase 9 — Effects expansion

New passes in the same "one pass, one toggle, a mode dropdown for variants"
shape the existing twelve already follow.

- **Voronoi / cellular** — shatter, stained-glass and mosaic looks from one
  cell-hash shader. Genuinely unlike anything currently in the chain.
- **Standalone pixelate** — lifted out of the palette pass so it composes
  with everything else.
- **Kuwahara** — the painterly/oil-paint filter. Distinctive, well
  documented, strong fit for abstract output.
- **Pixel sort** — rated worth building two planning rounds ago and still not
  built. The signature glitch-art technique, and the most expensive item
  here: it needs a real bitonic-style GPU sort, not a per-pixel shader trick.
- **Outline / toon** — `OutlinePass` ships with three and is unused. Cheap.
- **Real LUT files.** `LUTPass` ships with three, unused. Loading `.cube`
  files means the grade a colourist actually hands over, rather than only the
  brightness/contrast/hue maths the colour-grade pass does today. The closest
  thing on this list to a professional-tool feature.
- **More depth on what exists** — ASCII luminance remap and background
  colour, standalone chromatic aberration (reachable only inside CRT right
  now), standalone dither.

---

## Phase 10 — Environment and staging

- **Stage appearance** — colour, roughness, and a solid/gradient backdrop
  mode that needs no model at all.
- **Custom HDRI upload**, plus two or three curated environments beyond the
  single bundled sky.
- **Light colour pickers** for every light, not only the fills.
- **Light gizmos** — see and drag where lights actually are, instead of
  inferring position from an angle slider.

---

## Phase 11 — Multi-model scene composition

The largest item here, and the one that changes the app's shape rather than
adding to it: more than one model in a scene, each with its own transform, so
the app composes scenes instead of presenting a single subject.

What it needs:

- An **outliner** listing what is in the scene, with selection.
- **Transform gizmos.** `TransformControls` ships with three, so move /
  rotate / scale per object needs no new dependency, and `OutlinePass` gives
  the selection highlight for free.
- **Scoping everything currently global to a selection** — materials,
  colourways, orientation, animation clips, triangle budget, stats.
- **Saving and loading a composition**, and exporting the assembled scene as
  one GLB.

Worth being straight about the cost: `modelRoot` is a single slot today, and
bounds, framing, disposal, stats, materials, colourways, animation and
simplification all assume exactly one subject. This is an architectural
change across most of `src/core/`, not a feature bolted on the side — which
is why it sits behind the phases above rather than in front of them.

---

## Phase 12 — Output and sharing

- **MP4 export.** WebM does not play on Safari/iOS and does not drop into
  most editors — real friction for a tool whose output is meant to be posted.
  Needs `ffmpeg.wasm` or equivalent.
- **PNG sequence export** for anyone finishing in a real editor.
- **Before/after split view** for a Style pass, with a draggable divider.
- **Colourway contact sheet** — every colourway in one grid image.
- **Optional watermark** on exported images and clips.
- **Share by link** — encodes camera, lighting, colourway and Style state
  plus the model's *source*. Works only when that source is a URL or Drive
  link; a local file is pointed at GLB export instead, because a 4 MB upload
  cannot fit in a URL. Probably the biggest adoption lever on this list.
- **Embed snippet** for dropping a configured viewer into a page.

---

## Phase 13 — Inspect and reuse

- **Inspect modes** — wireframe, UV checker, normals, flat shading. Planned
  in the first rebuild plan and never built.
- **Named looks** — export and import a full rig plus Style chain as one
  small JSON, separate from the per-model colourways that already persist.
- **Measurement and bounding-box readout.**

---

## Not planned

Each of these was checked against what the app actually is — a live 3D
render, not layered footage — and ruled out rather than forgotten.

| | Why not |
|---|---|
| Path-traced / photoreal rendering | The gap to KeyShot is a ray tracer. That is a different project, not a missing setting |
| Data mosh, optical flow | Both need compressed-video motion vectors. A live GPU render has no encoded prior frame to mosh into |
| Slit-scan | Needs a ring buffer of many full-resolution past frames, for a look that suits a fast-orbiting product shot poorly |
| Masking, chroma key, background removal, layer compositing | All presume a stack of footage to cut between. There is one source here: the app's own render |
| 2D transform / reframe effects | There is a real 3D camera and a camera-path feature. Move the actual camera instead |
| Texture painting | Brushes, layers and UV-space compositing is a separate application. Texture *swap* is in scope; painting is not |
| Audio-reactive visualisation | Needs audio input and analysis — a new input category, not a new pass |
| Hardware-accurate console emulation | Real sprite and colour-count limits, rather than "looks retro", is a different goal |

---

## Principles these phases hold to

Worth writing down, because each one has already caught a bug or prevented
one:

- **Every render setting defaults to off and falls back pixel-exact.** All 15
  optional passes have a test asserting that switching them off returns the
  image to byte-identical. That is what makes the stack safe to keep adding
  to.
- **Explicit user choice always wins.** The device tier only ever forces
  quality *down*, at startup, and never silently changes something after a
  person has touched it. An auto-downgrade that quietly unchecked user
  toggles was built, caught, and reverted for exactly this reason.
- **One app, one panel, one engine.** No mode switch, no second shell, no
  separate pro build. Studio work and stylized work share one scene, one
  light rig and one export path.
- **Measure before optimising.** Compressing the demo model started by
  measuring where its 4.4 MB actually was — textures, not geometry — instead
  of reaching for the obvious tool.
