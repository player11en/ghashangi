// Super 8 film emulation.
//
// Deliberately its own pass rather than another crt-pass.js preset: a CRT
// and a film print are different *media* with artifacts that come from
// different physical causes, and mixing them into one uniform set would
// mean every CRT preset carrying dead film uniforms and vice versa. A tube
// has scanlines, a phosphor mask and convergence error; film has grain in
// the emulsion, dust on the print, weave in the gate and light leaking
// round the edges. Nothing meaningful is shared.
//
// Every artifact here is time-driven, so - like crt-pass.js's own grain and
// roll - it only actually animates while something else is keeping the
// on-demand render loop awake (an orbit, a playing clip, a recording). A
// still frame gets one deterministic sample of each, which is the right
// behavior for a screenshot anyway.

const filmVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const filmFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;

uniform float grain;
uniform float dust;
uniform float weave;
uniform float burn;
uniform float vignette;
uniform float warmth;

varying vec2 vUv;

float hash21(vec2 p){
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash11(float p){
    return fract(sin(p * 78.233) * 43758.5453);
}

void main(){
    // Gate weave: the film never sits in exactly the same place twice, so
    // the whole frame drifts by a fraction of a percent. Two sine rates so
    // it doesn't read as a clean oscillation.
    vec2 uv = vUv;
    uv.x += (sin(uTime * 3.1) * 0.6 + sin(uTime * 7.7) * 0.4) * weave * 0.002;
    uv.y += (sin(uTime * 2.3) * 0.6 + sin(uTime * 5.9) * 0.4) * weave * 0.002;

    vec3 color = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;

    // Emulsion grain: clumpier and softer than a digital sensor's per-pixel
    // noise, so it is sampled on a coarser grid than the pixel one.
    vec2 grainUv = floor(uv * uResolution / 2.0);
    float g = hash21(grainUv + floor(uTime * 24.0)) - 0.5;
    color += g * grain * 0.25;

    // Dust and hair on the print: sparse, and resampled on the projector's
    // frame rate rather than the display's, so specks hold for a beat
    // instead of strobing every frame.
    float frame = floor(uTime * 18.0);
    vec2 dustCell = floor(uv * 90.0);
    float speck = hash21(dustCell + frame * 13.0);
    float speckMask = step(1.0 - dust * 0.012, speck);
    color = mix(color, vec3(hash11(speck) > 0.5 ? 1.0 : 0.0), speckMask * 0.8);

    // Light leaking past the gate: a warm bloom that wanders the edge.
    if (burn > 0.0) {
        float edge = max(0.0, 1.0 - distance(uv, vec2(0.5 + sin(uTime * 0.7) * 0.35, 0.5)) * 1.7);
        color += vec3(1.0, 0.55, 0.18) * pow(edge, 3.0) * burn * 0.6;
    }

    // Warm the whole print toward the orange-shifted look of aged stock.
    color *= mix(vec3(1.0), vec3(1.08, 0.98, 0.86), warmth);

    float v = distance(uv, vec2(0.5));
    color *= 1.0 - v * vignette;

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createFilmShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      uTime: { value: 0 },
      grain: { value: 0.5 },
      dust: { value: 0.5 },
      weave: { value: 0.6 },
      burn: { value: 0.25 },
      vignette: { value: 0.45 },
      warmth: { value: 0.7 },
    },
    vertexShader: filmVertexShader,
    fragmentShader: filmFragmentShader,
  };
}

// Named looks rather than six raw sliders by default, matching crt-pass.js.
export const FILM_PRESETS = {
  super8: { grain: 0.5, dust: 0.5, weave: 0.6, burn: 0.25, vignette: 0.45, warmth: 0.7 },
  clean16mm: { grain: 0.25, dust: 0.15, weave: 0.25, burn: 0.05, vignette: 0.3, warmth: 0.35 },
  trashed: { grain: 0.9, dust: 1.0, weave: 1.0, burn: 0.6, vignette: 0.6, warmth: 0.85 },
};

export function applyFilmPreset(pass, name) {
  const preset = FILM_PRESETS[name];
  if (!preset || !pass) return;
  for (const [key, value] of Object.entries(preset)) {
    if (pass.uniforms[key]) pass.uniforms[key].value = value;
  }
}
