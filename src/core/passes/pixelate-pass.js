// Standalone pixelation.
//
// Pixelation already existed in this app, but only as a uniform inside
// palette-pass.js - so getting a pixelated image also meant quantizing to a
// fixed console palette and ordered-dithering it. Those are three separate
// looks that happened to ship welded together because the retro-console
// preset wanted all three at once. This pass is the same block-resample on
// its own, so it composes with anything: pixelate + CRT, pixelate + ASCII,
// pixelate with the scene's real colours left alone.
//
// palette-pass.js keeps its own copy of the maths rather than importing this
// one. Two reasons, both deliberate: the palette pass dithers *per output
// block* (it needs the block grid inside the same shader, not a pre-pixelated
// input), and going through this pass first would resample twice - once here,
// once there - which visibly softens the block edges the whole effect is for.
//
// Not RenderPixelatedPass, for the same reason palette-pass.js documents: that
// one replaces RenderPass and re-renders the scene at reduced resolution, so
// it only works as the first pass in a composer. This has to filter an
// already-composited frame, which is an ordinary ShaderPass.

const pixelateVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const pixelateFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float pixelSize;
// Non-square blocks on purpose: 2:1 is what a lot of genuinely low-resolution
// hardware actually had, and it is not reachable at all from a single size.
uniform float aspect;
// Grid lines between blocks, for the "visible LED/LCD matrix" look rather than
// clean flat blocks. 0 = off.
uniform float gridStrength;

varying vec2 vUv;

void main(){
    vec2 size = vec2(max(pixelSize * aspect, 1.0), max(pixelSize, 1.0));
    vec2 blocks = uResolution / size;

    // Snap the sample point to the block grid, so one sampled colour covers
    // the whole block.
    vec2 cell = floor(vUv * blocks);
    vec2 blockUv = (cell + 0.5) / blocks;
    vec3 color = texture2D(tDiffuse, blockUv).rgb;

    if (gridStrength > 0.0) {
        // Distance to the block edge, in block-local space: darken a thin
        // border so the matrix reads as physical pixels with gaps.
        vec2 withinBlock = fract(vUv * blocks);
        vec2 edge = min(withinBlock, 1.0 - withinBlock);
        float line = min(edge.x, edge.y);
        float gap = smoothstep(0.0, 0.08, line);
        color *= mix(1.0 - gridStrength, 1.0, gap);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createPixelateShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      pixelSize: { value: 6 },
      aspect: { value: 1 },
      gridStrength: { value: 0 },
    },
    vertexShader: pixelateVertexShader,
    fragmentShader: pixelateFragmentShader,
  };
}
