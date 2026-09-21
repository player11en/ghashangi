// Repetition/symmetry pass: Mirror / Kaleido / Tile, one mode dropdown
// rather than three separate passes - the same "one pass, one shader,
// mode uniform switches behavior" shape crt-pass.js and palette-pass.js
// already established.
//
// All three are plain UV-remap shaders: instant, striking symmetry from
// any live scene, and a VJ/abstract-art staple, at negligible GPU cost.

const repeatVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const repeatFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform float mode; // 0 mirror, 1 kaleido, 2 tile
uniform float amount; // mirror: unused; kaleido: sides; tile: repeat count
uniform float angle;

varying vec2 vUv;

vec2 rotateUv(vec2 uv, float a){
    vec2 c = uv - 0.5;
    float s = sin(a);
    float co = cos(a);
    return vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
}

void main(){
    vec2 uv = vUv;

    if (mode < 0.5) {
        // Mirror: reflect one half onto the other, along an axis set by angle.
        vec2 ru = rotateUv(uv, -angle);
        if (ru.x > 0.5) ru.x = 1.0 - ru.x;
        uv = rotateUv(ru, angle);
    } else if (mode < 1.5) {
        // Kaleido: wedge-mirror around the center into "amount" sides.
        vec2 c = uv - 0.5;
        float r = length(c);
        float a = atan(c.y, c.x) - angle;
        float wedge = 6.28318530718 / max(amount, 2.0);
        a = mod(a, wedge);
        if (a > wedge * 0.5) a = wedge - a;
        uv = vec2(cos(a), sin(a)) * r + 0.5;
    } else {
        // Tile: repeat the frame "amount" times across, rotated by angle.
        uv = fract((rotateUv(uv, angle) - 0.5) * max(amount, 1.0) + 0.5);
    }

    gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createRepeatShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      mode: { value: 0 },
      amount: { value: 6 },
      angle: { value: 0 },
    },
    vertexShader: repeatVertexShader,
    fragmentShader: repeatFragmentShader,
  };
}

export const REPEAT_MODES = { mirror: 0, kaleido: 1, tile: 2 };

export function setRepeatMode(pass, name) {
  const mode = REPEAT_MODES[name];
  if (mode === undefined || !pass) return;
  pass.uniforms.mode.value = mode;
}
