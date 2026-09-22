// Standalone ordered dithering.
//
// Dithering already existed here, but only welded inside palette-pass.js -
// so getting a dither pattern also meant pixelating and quantizing to a fixed
// console palette. Pixelation got split out for the same reason; this finishes
// that job. The three are genuinely separate looks that happened to ship fused
// because the retro-console preset wanted all three at once.
//
// What this adds over the palette pass's version: the palette one dithers
// toward a fixed set of console colours, which is the right thing for a GBA
// look and the wrong thing if you want a 1-bit newsprint or a two-tone poster.
// Here the quantization target is a plain level count per channel, plus a
// monochrome mode - so it covers the Atkinson/newsprint territory the palette
// pass cannot reach.
//
// palette-pass.js keeps its own copy rather than importing this, exactly as
// pixelate-pass.js does, because it has to dither per *output block* - the
// dither cell must line up with the pixelation grid, not with screen pixels,
// or the pattern crawls underneath the blocks instead of reading as part of
// them.

const ditherVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const ditherFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
// Levels per channel after dithering. 2 is the classic 1-bit look.
uniform float levels;
uniform float strength;
// Size of one dither cell in screen pixels. Above 1 the pattern reads as a
// deliberate texture rather than as noise.
uniform float scale;
uniform float monochrome;
uniform float matrixSize; // 4 for Bayer 4x4, 8 for 8x8

varying vec2 vUv;

// Bayer 4x4, values 0..15 normalised to 0..1.
float bayer4(vec2 p){
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int index = x + y * 4;
    float v = 0.0;
    if (index == 0) v = 0.0;      else if (index == 1) v = 8.0;
    else if (index == 2) v = 2.0;  else if (index == 3) v = 10.0;
    else if (index == 4) v = 12.0; else if (index == 5) v = 4.0;
    else if (index == 6) v = 14.0; else if (index == 7) v = 6.0;
    else if (index == 8) v = 3.0;  else if (index == 9) v = 11.0;
    else if (index == 10) v = 1.0; else if (index == 11) v = 9.0;
    else if (index == 12) v = 15.0;else if (index == 13) v = 7.0;
    else if (index == 14) v = 13.0;else v = 5.0;
    return v / 16.0;
}

// Bayer 8x8, built from the 4x4 by the standard recursive rule:
// M(2n) = [4M(n), 4M(n)+2; 4M(n)+3, 4M(n)+1] / 4. Finer grain, so it reads
// closer to a photographic screen than a visible checker.
float bayer8(vec2 p){
    vec2 q = floor(mod(p, 8.0) / 4.0);
    float base = bayer4(p) * 16.0;
    float quadrant = q.x + q.y * 2.0;
    float add = 0.0;
    if (quadrant == 0.0) add = 0.0;
    else if (quadrant == 1.0) add = 2.0;
    else if (quadrant == 2.0) add = 3.0;
    else add = 1.0;
    return (base * 4.0 + add) / 64.0;
}

void main(){
    vec3 color = texture2D(tDiffuse, vUv).rgb;

    vec2 cell = floor(vUv * uResolution / max(scale, 1.0));
    float threshold = matrixSize > 6.0 ? bayer8(cell) : bayer4(cell);

    if (monochrome > 0.5){
        color = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
    }

    float steps = max(levels - 1.0, 1.0);
    // Offset by the threshold before quantizing: that is the whole trick.
    // Values land on either side of a step depending on where they sit in the
    // matrix, so a flat region becomes a pattern rather than a hard band.
    vec3 dithered = floor(color * steps + (threshold - 0.5)) / steps;
    dithered = clamp(dithered, 0.0, 1.0);

    gl_FragColor = vec4(mix(color, dithered, strength), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createDitherShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      levels: { value: 4 },
      strength: { value: 1 },
      scale: { value: 1 },
      monochrome: { value: 0 },
      matrixSize: { value: 4 },
    },
    vertexShader: ditherVertexShader,
    fragmentShader: ditherFragmentShader,
  };
}
