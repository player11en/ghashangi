// Displacement pass: Wave / Wobble / Jitter / Shake, one mode dropdown -
// kept independent of crt-pass.js's own analogWarp() (jitter/tracking/
// roll) on purpose, since someone may want Wobble without CRT's
// scanlines/mask/vignette/curvature coming along with it. Also fills out
// "Glitch" with variety beyond three's single built-in GlitchPass, which
// reads as a fairly dated look on its own.

const displaceVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const displaceFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform float mode; // 0 wave, 1 wobble, 2 jitter, 3 shake
uniform float amount;
uniform float size;
uniform float speed;
uniform float angle;
uniform float uTime;

varying vec2 vUv;

float hash21(vec2 p){
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main(){
    vec2 uv = vUv;
    vec2 dir = vec2(cos(angle), sin(angle));

    if (mode < 0.5) {
        // Wave: a single clean sine wave along "dir".
        float d = dot(uv - 0.5, dir);
        float wave = sin(d * size * 20.0 + uTime * speed) * amount * 0.02;
        uv += vec2(-dir.y, dir.x) * wave;
    } else if (mode < 1.5) {
        // Wobble: smooth rolling distortion across both axes.
        uv.x += sin(uv.y * size * 20.0 + uTime * speed) * amount * 0.02;
        uv.y += sin(uv.x * size * 20.0 + uTime * speed * 1.3) * amount * 0.02;
    } else if (mode < 2.5) {
        // Jitter: small, fast random displacement - the picture never settles.
        float t = floor(uTime * speed * 10.0);
        vec2 n = vec2(hash21(vec2(t, 1.0)), hash21(vec2(t, 2.0))) - 0.5;
        uv += n * amount * 0.02;
    } else {
        // Shake: the whole frame displaced, frame by frame, like a knocked camera.
        float t = floor(uTime * speed * 6.0);
        vec2 n = vec2(hash21(vec2(t, 3.0)), hash21(vec2(t, 4.0))) - 0.5;
        uv += n * amount * 0.05;
    }

    gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createDisplaceShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      mode: { value: 0 },
      amount: { value: 1 },
      size: { value: 1 },
      speed: { value: 1 },
      angle: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: displaceVertexShader,
    fragmentShader: displaceFragmentShader,
  };
}

export const DISPLACE_MODES = { wave: 0, wobble: 1, jitter: 2, shake: 3 };

export function setDisplaceMode(pass, name) {
  const mode = DISPLACE_MODES[name];
  if (mode === undefined || !pass) return;
  pass.uniforms.mode.value = mode;
}
