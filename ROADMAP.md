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
| **Fidelity** | GTAO ambient occlusion, SMAA, depth of field, silhouette outline — each lazily loaded, each with a pixel-exact off state |
| **Style** | 17 reorderable stylization passes: CRT, film, retro palette, pixelate, dither, ASCII, halftone, bloom, glitch, trails, colour grade, LUT, tone, repeat, displace, Voronoi, painterly, pixel sort |
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

## Phase 8 — Framing and composition feedback — **SHIPPED**

Three of the four items done; the fourth turned out to be smaller than a
bullet point once it was measured.

**Render-frame overlay** (`src/ui/frame-guide.js`). Dimmed bars marking where
an export will crop, live, while composing — Blender's camera passepartout.
Eight ratios: 9:16, 4:5, 1:1, 4:3, 3:2, 16:9, 21:9 and free, with the real
output pixel size shown next to the ratio (multiplied by the screenshot scale,
so the number is what a capture actually produces rather than something to
work out).

Deliberately *not* the aspect lock in `aspect-lock.js`, which physically
resizes the viewport: that is right for the moment a recording runs and wrong
for everything before it, because it changes the canvas resolution and only
exists while a preview or recording is active. This touches nothing — not the
renderer, not the canvas, not the camera. Two guarantees are what make it a
guide rather than an obstacle, and both have tests: it never appears in the
exported image (asserted byte-identical), and it never intercepts a pointer
event (`pointer-events: none`, with an actual drag-to-orbit through it in the
suite).

One honest interaction worth knowing: the panel floats over the viewport, so
the right edge of a wide frame sits behind it. The guide is still telling the
truth — `lockAspect` centres a capture on the full window too, so the render
really does extend under the panel — and offsetting the overlay to "look
right" would make it lie about where the crop lands. Collapsing the panel
shows the whole frame. If this proves annoying in practice the fix is a layout
question (panel pushing the viewport rather than floating over it), not a
change to the guide.

**Five saved views.** Front, three-quarter, side, top and back, in the Model
section. Built as a `direction` option on `frameCamera()` rather than new
camera maths, so they inherit its fit distance, near/far derivation and
OrbitControls limits. The test that matters asserts all five frame at the
*same* distance — a view that drifts from that means the shared path got
bypassed, which is the only way this rots.

Top is `(0, 1, 0.001)`, and the fraction is load-bearing: a view direction
exactly parallel to the camera's up vector has no unique orientation, so
`lookAt()` has nothing to solve. A test asserts the world matrix stays finite,
because that is how the failure actually shows up.

**Locked-off camera recording.** Two entry points: "Record current view",
which needs no waypoints, and a one-waypoint camera path for "record from the
framing I saved earlier". This closes a gap that was invisible in the feature
list — the turntable rotates the model, a camera path demanded movement, a
screenshot is one frame, so the shot a still camera exists for was
unreachable. That matters most for a model playing its own animation clip and
for the time-varying Style passes, all of which move on their own.

Checking before estimating paid off here: `recordClip()`'s `onFrame` already
defaulted to a no-op and `evaluate()` already handled a single waypoint, so
what blocked it was three `< 2` guards. `recordStatic()` is nine lines, and
the only genuinely new behaviour in it is pausing auto-rotate for the duration
— "locked off" has to mean locked off, or it is a turntable with extra steps.

**Not done: custom W:H.** The eight presets cover what things are actually
exported for, and an arbitrary ratio field is a text-input-validation feature
rather than a framing one. Worth adding if a real need for an odd ratio turns
up; not worth it on speculation.

---

## Phase 8.5 — Progressive disclosure, not a Pro mode — **SHIPPED**

The question of how ~120 controls stay approachable came up as "split the app
into Open and Pro", and the answer landed on **one interface with an Advanced
reveal** instead. Kept with its reasoning because the panel-split question has
now been asked three times, and a fourth should start from the argument rather
than from scratch.

**What shipped.** 71 rows carry `data-advanced`; one switch in the panel
header reveals them. Measured on the real panel: **40 visible controls with it
off, 62 with it on**, out of 124 total. The Style tab is where it bites
hardest — with three effects enabled it shows **15 controls simple against 30
advanced**, and those 15 are the 13 effect toggles plus the two preset
dropdowns those effects expose.

That split is deliberate: an effect's **toggle and its preset/mode dropdown
stay visible**, because picking a look is the easy-entry path, while its
numeric parameters are the part you opt into. Hand-tuning CRT's scanline
parameters is advanced; choosing "VHS" is not.

**The rule that makes it safe**, and the reason it was chosen over a mode
split: **a control changed from its shipped default stays visible even with
Advanced off.** Nothing that is affecting the render can ever be hidden, so
switching Advanced off can only ever hide controls doing nothing. It tracks
the live value rather than a one-way "was touched" flag — returning a control
to its default lets it tuck away again, verified in the suite both directions.

Hiding uses a class, not the `hidden` attribute, because rows already use that
attribute for their own conditional logic (a Style effect's parameters appear
when the effect is switched on). Two independent reasons to hide one element
cannot share one attribute without clobbering each other; a test asserts they
compose.

**One bug introduced and caught by the suite**, worth recording because it is
a general shape: `refresh()` ran on every input event and re-queried all 71
rows with a linear field lookup per control, and `settings.load()` dispatches
an event for every tracked field at startup — so a page reload did on the
order of 700,000 DOM queries and blew past a 30-second timeout. The
tab-persistence check, which reloads the page, is what surfaced it. Fixed by
resolving the rows once (they are static markup) and coalescing refreshes to
one per frame, plus a Map for field lookup in settings.js.

The timeline from Phase 10 still lands as a collapsed-by-default section
regardless — it genuinely is a large surface — but collapsed is not the same
thing as a separate application.

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

## Phase 9 — Effects expansion — **SHIPPED**

Six additions, taking the Style chain from 13 passes to 17 plus a new
fidelity-band pass. Every one keeps the established shape: one toggle, a
mode or preset dropdown where there are variants, numeric parameters behind
the Advanced reveal, forced off on the low tier, and a pixel-exact image when
switched back off.

**Real LUT grading.** three ships `LUTPass` and three LUT loaders and none had
been used. Five generated presets so the toggle does something immediately,
plus `.cube` and `.3dl` file loading — the format Resolve, Premiere and camera
vendors export, which is the difference between having colour sliders and
accepting the same grade as the rest of a pipeline. The colour-grade pass
stays: live maths is what you want while dialling a look in, a fixed table is
what you want when someone else authored it.

**Voronoi** — mosaic, stained glass and shatter from one cell shader. Sites
come from hashing the integer grid and searching the 3x3 neighbourhood, which
keeps it a single pass with no buffers where a true N-site diagram would need
a nearest-neighbour search.

**Painterly (Kuwahara)** — edge-preserving smoothing, which is why it reads as
brushwork rather than blur. Honest limitation: it needs texture detail to have
anything to turn into strokes, so it is mild on a clean product render and
much stronger on photographic or detailed geometry.

**Standalone dither** — finishes the split pixelate got earlier in the phase.
Quantizes to a level count rather than fixed console colours, so it reaches
1-bit and newsprint territory the palette pass structurally cannot. Bayer 8x8
is derived from the 4x4 by the standard recursive rule rather than typed out
twice.

**Outline** — in the fidelity band with AO/AA/DOF, not the Style chain,
because it re-renders the silhouette from the real scene and that scene is
gone once a Style pass has rewritten the image. Reaches what Sobel edges
cannot: a light model on a light backdrop has no luminance contrast, but still
has a silhouette.

**Pixel sort** — and worth being precise, because the name usually means
something slightly different. The classic technique sorts arbitrarily long
runs, which on a GPU needs multi-pass bitonic sorting with ping-pong buffers.
This is a *window-limited* sort: within the window pixels are genuinely ranked
by luminance via binary search on value (eight steps, O(8n) rather than
O(n^2)), so it is a real sort and not a smear standing in for one. The visible
difference is that streaks stop at the run length instead of crossing the
frame. Same honest caveat as Painterly — smooth content is already in sorted
order, so it shows on detail and noise, and pairs well after another pass.

Two recurring lessons, both now paid for three times over:

- **`post.js` has two places that destructure the lazily loaded modules.**
  Adding a pass means touching both, and forgetting shows up only at runtime.
  `BokehPass`, `LUTPass` and `OutlinePass` each hit this; the third one also
  knocked `GlitchPass` off the line it was inserted into.
- **Syntax-check generated test files before running them.** A mis-escaped
  newline wrote a literal line break inside a string, and `node --check`
  turned a confusing suite failure into an obvious one.

Not built, deliberately: standalone chromatic aberration. It is reachable
inside the CRT pass, and pulling it out is worth doing when something actually
wants it without the scanlines, not on speculation.

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
