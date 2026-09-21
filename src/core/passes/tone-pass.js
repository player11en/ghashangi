// Tone/contrast pass: Posterize / Solarize / Edges, one mode dropdown -
// same shape as the other Style passes. All three are cheap and read
// strongly, and complement the retro-palette pass (palette-pass.js)
// without duplicating it: that pass quantizes to a *fixed console
// palette*; these reshape tone independent of any palette.

const toneVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const toneFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float mode; // 0 posterize, 1 solarize, 2 edges
uniform float levels;
uniform float solarizeThreshold;
uniform vec3 edgeColor;
uniform float passthru;

varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
    vec2 texel = 1.0 / uResolution;
    vec3 color = texture2D(tDiffuse, vUv).rgb;

    if (mode < 0.5) {
        color = floor(color * levels + 0.5) / levels;
    } else if (mode < 1.5) {
        float l = luma(color);
        color = mix(color, 1.0 - color, step(solarizeThreshold, l));
    } else {
        // Sobel edge detection on luminance.
        float tl = luma(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  1.0)).rgb);
        float t  = luma(texture2D(tDiffuse, vUv + texel * vec2( 0.0,  1.0)).rgb);
        float tr = luma(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  1.0)).rgb);
        float l0 = luma(texture2D(tDiffuse, vUv + texel * vec2(-1.0,  0.0)).rgb);
        float r  = luma(texture2D(tDiffuse, vUv + texel * vec2( 1.0,  0.0)).rgb);
        float bl = luma(texture2D(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb);
        float b  = luma(texture2D(tDiffuse, vUv + texel * vec2( 0.0, -1.0)).rgb);
        float br = luma(texture2D(tDiffuse, vUv + texel * vec2( 1.0, -1.0)).rgb);
        float gx = -tl - 2.0 * l0 - bl + tr + 2.0 * r + br;
        float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
        float edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);

        // Passthru blends the original back in as a backdrop behind the
        // lines, which stay fully visible either way - not a crossfade
        // that would make the lines disappear as passthru increases.
        vec3 backdrop = mix(vec3(0.0), color, passthru);
        color = clamp(backdrop + edgeColor * edge, 0.0, 1.0);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createToneShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      mode: { value: 0 },
      levels: { value: 4 },
      solarizeThreshold: { value: 0.5 },
      edgeColor: { value: [1, 1, 1] },
      passthru: { value: 0 },
    },
    vertexShader: toneVertexShader,
    fragmentShader: toneFragmentShader,
  };
}

export const TONE_MODES = { posterize: 0, solarize: 1, edges: 2 };

export function setToneMode(pass, name) {
  const mode = TONE_MODES[name];
  if (mode === undefined || !pass) return;
  pass.uniforms.mode.value = mode;
}
