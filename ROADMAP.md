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
| **Style** | 13 reorderable stylization passes: CRT, film, retro palette, pixelate, ASCII, halftone, bloom, glitch, trails, colour grade, tone, repeat, displace |
| **Animation** | Clip list, transport, scrub, speed, loop |
| **Output** | Screenshots to 4x with optional transparency, turntable WebM, camera-path clips with 9:16 / 1:1 aspect lock |
| **Performance** | On-demand rendering (0 fps at rest), device capability tiers, dense-model triangle budget, ~1.4 MB first load |

234 checks across 8 browser suites. See [test/README.md](test/README.md).

---

## Phase 7 — Control gaps and panel overview — **SHIPPED**

Everything here was small, and all of it came out of actually using the app
rather than reading the code. Four of the six gaps turned out to be controls
that already existed in the engine with no way to reach them.

Delivered: bloom threshold + radius, dither strength, light colour (sun and
both fills), ASCII letter width/height/spacing/contrast/brightness/background,
standalone pixelate (with pixel aspect and grid lines), stage colour and
roughness, a global settings reset, five panel tabs replacing the thirteen-
section scroll and its jump rail, and drag-to-reorder on the Style chain.

234 checks across 8 suites, zero failures. Two bugs were found by testing
rather than by reasoning: the stage appearance defaults did not match
Stage.glb's authored material, and because settings.js restores a field by
dispatching a real `input` event — indistinguishable from a user drag — the
"preserve unless touched" flag it relied on could never work.

### Worth keeping from the diagnosis

Two of these are the interesting ones, because they are the pattern rather
than the individual bug:

- **Bloom's threshold and radius had existed since bloom shipped**, wired to
  nothing. Threshold therefore sat at 0.7 permanently, which is the whole
  reason "turn the lights up and enable bloom" blew the frame out with no
  available response except dimming the highlights that should bloom. Same
  story for dither strength, hardcoded at 0.06 inside the palette shader.
  Working engine code with no route to it is invisible in a feature list and
  reads to a user as a missing feature.
- **ASCII could not express what was asked for.** "Letter width and
  closeness" was not a missing slider: a single `cellSize` uniform made
  terminal proportions unreachable, because glyphs are baked into *square*
  atlas cells and a square screen cell stretches every character. Width and
  height are independent now, and spacing shrinks the glyph inside its cell
  rather than shrinking the grid, so tuning the gaps does not move the
  character layout.

### Left over, and worth naming

The tabs fixed the panel, not the Style tab. It still lists 13 effect
checkboxes and then, directly underneath, the same 13 names again as chain
rows — every effect, whether or not it is switched on. So the densest tab in
the app is roughly twice as long as it needs to be, and most of its second
list is inert. Filtering the chain list to enabled effects (with a hint when
it is empty) is a small change and the single biggest remaining readability
win in the panel.

Also unfinished from this phase: pixelation was split out of the palette pass
so it composes freely, and dithering was not. A standalone dither pass is in
Phase 9.

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
- **Record from a locked-off camera** — a clip from the current view, or from
  one saved waypoint held for the whole duration, with nothing moving but the
  scene itself.

  Currently impossible, and the gap is not obvious from the feature list:
  turntable rotates the model, a camera path demands movement between at least
  two waypoints, and a screenshot is one frame. There is no way to record the
  thing a locked-off camera is *for* — a model playing its own animation clip,
  or the time-varying Style passes (glitch, trails, displace, film grain, and
  any keyframed parameter from Phase 10) which all produce motion on their own
  without the camera doing anything.

  **Cheapest item in this roadmap, verified rather than assumed.** Two things
  already support it:

  - `recorder.js`'s `onFrame` already defaults to a no-op, so
    `recordClip()` with no per-frame callback records a static camera today.
    The generic recorder needs no changes at all.
  - `camera-path.js`'s `evaluate()` already handles `waypoints.length === 1`
    explicitly, returning that waypoint's position and target.

  What blocks it is three explicit guards, nothing structural: `play()` and
  `recordCameraPath()` both bail below two waypoints, and the panel disables
  Preview and Record on the same condition. A one-waypoint path is a valid
  static shot, not an incomplete move.

  Two entry points worth having, since they answer different questions:
  "record what I am looking at right now" needs no waypoints at all, and
  "record from the framing I saved earlier" is the relaxed one-waypoint path.

---

## Phase 8.5 — Progressive disclosure, not a Pro mode

119 controls exist now, and every future phase adds more. The question of how
to keep that from burying a first-time user came up as "split the app into
Open and Pro", and the answer landed on **one interface with an Advanced
reveal** instead. Recorded with the reasoning because the panel-split question
has now been asked three times, and a fourth time should start from here
rather than from scratch.

**What gets built.** Each control carries a `data-advanced` flag. One switch in
the panel header toggles it. Off, the panel shows roughly the forty controls
that matter for "open a model and make it look good" across the same five
tabs. On, it shows everything. The timeline from Phase 10 lands as a
collapsed-by-default section either way, because it genuinely is a large
surface — but collapsed is not the same thing as a separate application.

**The rule that makes it safe: a control changed from its default stays
visible even with Advanced off.** Nothing that is actively affecting the
render is ever hidden. That single rule is what a mode split cannot offer, and
it is the deciding argument, not a refinement:

- A timeline built in a Pro mode keeps animating the output after switching to
  Open, while being unreachable and invisible. There is no way to discover why
  the render is moving.
- This project already reverted one feature for exactly that failure — the
  tier auto-downgrade silently unchecked a user's own AO and Style toggles
  during an ordinary slowdown. Hidden state changing visible output, with no
  explanation available, is a bug class this codebase has decided against
  once already.

**The costs a mode split also carries**, worth having written down:

- Every future feature gains a recurring "Open or Pro?" placement decision -
  a tax on every addition, paid forever, resolved by guesswork.
- Features in Pro become undiscoverable. The person most likely to benefit
  from learning them is the one who never opens that mode.
- The test suite currently asserts every section lives on exactly one tab. Two
  modes means two layouts to verify, doubling the UI surface under test.
- It is hard to un-split. Collapsing a disclosure back down is easy; merging
  two shells that have drifted apart is not.

**What stays true from the original decision.** One app, one engine, one
export path, one URL, no audience switch. An Advanced reveal is the same shape
as the tab grouping already shipped: it changes how much is on screen, not
what the app is or who it is for.

---

## Phase 9 — Effects expansion

New passes in the same "one pass, one toggle, a mode dropdown for variants"
shape the existing twelve already follow.

- **Voronoi / cellular** — shatter, stained-glass and mosaic looks from one
  cell-hash shader. Genuinely unlike anything currently in the chain.
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
- **More depth on what exists** — standalone chromatic aberration (reachable
  only inside CRT right now), and a standalone dither to finish the split that
  pixelate already got.

---

## Phase 10 — Timeline and keyframes

The natural endpoint of the camera path, and the thing that multiplies every
effect already built: keyframe an effect's *parameters* over time, keyframe
effects on and off, and eventually edit all of it on one timeline rather than
through a duration slider.

A hue that cycles across a clip, a CRT that cuts in for eight frames, a
pixelate that coarsens as the camera pulls out — none of those are new
shaders. They are the existing uniforms, animated. That is why this sits ahead
of multi-model composition despite being smaller: it raises the ceiling on
work already shipped instead of adding a new category of work.

**Most of the substrate exists**, which is the main argument for doing it
properly rather than bolting an animation onto one effect:

- `camera-path.js` already exposes `preview(t)` over a normalised 0..1 scrub.
  If keyframes use that same normalised clock, camera moves, parameter
  animation and clip recording all share one timeline instead of three.
- `post.js` already routes parameters through generic per-pass setters
  (`setAsciiParam`, `setPixelateParam`, `setHalftoneParam`, …), so a keyframe
  track can address a target as `(passKey, uniformName, value)` without a new
  dispatch layer.
- `settings.js`'s `FIELDS` is already a registry of all 94 controls and their
  kinds. A keyframe UI should read that registry rather than maintain a second
  list of what is animatable, or the two will drift the way every duplicated
  table in this project has.
- The recorder already holds the render loop open for the duration of a
  capture, so frames are continuous while a clip records — which is exactly
  what interpolation needs and is not true at rest, where the loop idles at
  zero.

**The one real trap, worth writing down before anyone starts.** Enabling a
Style effect is asynchronous: `setStyleEnabled()` lazily imports the pass
module the first time it is switched on. A keyframe that turns an effect on
mid-playback would therefore trigger a module load in the middle of a
recording and drop frames. The fix is a pre-roll: instantiate every pass the
timeline references *before* playback starts, then only flip `pass.enabled`
during playback, which is synchronous and free. Anything that keyframes
on/off state has to do this or the recording will stutter exactly where the
effect appears.

Staging, smallest first, because each step is useful alone:

1. **One parameter, animated.** Keyframe a single numeric uniform (hue is the
   obvious first: visually obvious, cheap, and loops cleanly) across the
   existing camera-path duration. Proves the clock and the interpolation.
2. **Any parameter.** Generalise to any `FIELDS` entry with a numeric or
   colour kind, addressed through the existing per-pass setters.
3. **On/off keyframes**, with the pre-roll above.
4. **A real timeline UI** — tracks, keyframes, drag to move, an editable
   duration — replacing the duration slider rather than sitting beside it.
   Camera waypoints become one track among several at this point instead of
   their own separate feature.
5. **Easing per keyframe.** Linear reads mechanical on camera moves already;
   it will read worse on a hue sweep.

Not Blender's dope sheet. Blender edits a scene graph with hundreds of
animatable channels; this needs a handful of tracks over a clip that is
usually five to fifteen seconds, and the low-entry promise means the timeline
has to stay closed and out of the way until someone asks for it.

## Phase 11 — Environment and staging

- **Stage appearance** — colour, roughness, and a solid/gradient backdrop
  mode that needs no model at all.
- **Custom HDRI upload**, plus two or three curated environments beyond the
  single bundled sky.
- **Light colour pickers** for every light, not only the fills.
- **Light gizmos** — see and drag where lights actually are, instead of
  inferring position from an angle slider.

---

## Phase 12 — Multi-model scene composition

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

## Phase 13 — Output and sharing

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

## Phase 14 — Inspect and reuse

- **Inspect modes** — UV checker, normals, flat shading. Wireframe already
  ships (Model tab); the rest of that original list never got built.
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
- **Opening it has to stay free.** 119 controls now exist, and the defence
  against that is not restraint in what gets added — it is that every one of
  them defaults to off or to the shipped value, so dropping a file still gets
  a framed, lit, good-looking render with zero clicks. Depth is reached by
  revealing more of the same panel (Phase 8.5), never by switching into a
  different one. Any feature that has to
  be configured before the app is useful breaks the only real advantage this
  has over Marmoset or KeyShot. The timeline in Phase 10 is the first item on
  this list with a serious chance of breaking that rule, which is why it stays
  collapsed until asked for.
- **Measure before optimising.** Compressing the demo model started by
  measuring where its 4.4 MB actually was — textures, not geometry — instead
  of reaching for the obvious tool.
