// CRT shader pass: barrel distortion, scanlines, shadow mask, chromatic
// aberration, halation, analog jitter/roll/noise, vignette, rounded-corner
// glass.
//
// Ported from a separate reference project (CRTTV), evaluated directly
// before porting rather than assumed portable: it's a plain GLSL
// ShaderMaterial full-screen-quad shader, exactly the shape three's own
// ShaderPass wants, so this is a rename-and-trim, not a rewrite. Two things
// dropped from the source: its own hand-rolled bloom (this app uses three's
// UnrealBloomPass instead, in post.js, ahead of this pass in the composite
// order) and its aspect-ratio letterbox/crop logic (that existed to fit
// external video/image media into a fixed canvas - irrelevant here, since
// this pass always processes the exact frame the 3D scene just rendered at
// the canvas's own resolution).
//
// uTime matters for the animated bits (jitter/tracking/roll/noise): under
// on-demand rendering, a preset that leans on these only actually animates
// while something else keeps the loop open (camera orbit, an exported
// recording). Presets default those fairly low specifically so enabling CRT
// on an otherwise-static view doesn't quietly force continuous rendering -
// the same "an effect must not itself demand 60fps" rule AO/AA follow.

export const CRT_TEXTURE_ID = 'tDiffuse';

const crtVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const crtFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;

uniform float curve;
uniform float overscan;
uniform float corners;

uniform float beamWidth;
uniform float beamSharpness;
uniform float smear;

uniform float maskStrength;
uniform float subpixelSize;
uniform float maskType;

uniform float scanlines;

uniform float halation;

uniform float convergence;
uniform float bleed;

uniform float tracking;
uniform float noise;
uniform float jitter;
uniform float roll;

uniform float reflection;
uniform float vignette;

uniform float brightness;
uniform float contrast;

uniform vec3 color_tint;
uniform float color_quantization;

varying vec2 vUv;

float hash(vec2 p){
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 barrel(vec2 uv){
    vec2 p = uv * 2.0 - 1.0;
    float r = dot(p, p);
    p *= 1.0 + curve * r;
    return p * 0.5 + 0.5;
}

vec2 applyOverscan(vec2 uv){
    return (uv - 0.5) / (1.0 + overscan) + 0.5;
}

vec2 analogWarp(vec2 uv){
    uv.x += sin(uv.y * 90.0 + uTime * 12.0) * jitter * 0.001;
    uv.x += sin(uTime * 8.0) * tracking * 0.001;
    uv.y += sin(uTime) * roll * 0.001;
    return uv;
}

vec3 rgbSample(vec2 uv){
    float shift = (convergence + bleed) / 1500.0;
    float r = texture2D(tDiffuse, uv + vec2(shift, 0.0)).r;
    float g = texture2D(tDiffuse, uv).g;
    float b = texture2D(tDiffuse, uv - vec2(shift, 0.0)).b;
    return vec3(r, g, b);
}

vec3 beam(vec2 uv){
    vec3 col = vec3(0.0);
    float total = 0.0;
    for(int i = -2; i <= 2; i++){
        float x = float(i) * smear * 0.001;
        float w = exp(-abs(float(i)) * beamWidth);
        col += texture2D(tDiffuse, uv + vec2(x, 0.0)).rgb * w;
        total += w;
    }
    col /= total;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float glow = pow(max(lum, 0.0), beamSharpness);
    return col + glow * 0.08;
}

float scan(vec2 uv){
    float line = sin(uv.y * uResolution.y * 3.14159);
    return mix(1.0, 0.65 + line * 0.35, scanlines);
}

float mask(vec2 uv){
    vec2 p = uv * uResolution / subpixelSize;
    if(maskType < 0.5){
        float rgb = mod(floor(p.x), 3.0);
        return rgb == 1.0 ? 0.85 : 1.0;
    }
    if(maskType < 1.5){
        return 0.8 + 0.2 * step(0.5, fract(p.x));
    }
    float dotPattern = sin(p.x * 3.14) * sin(p.y * 3.14);
    return 0.8 + dotPattern * 0.2;
}

float cornerMask(vec2 uv){
    if(corners <= 0.0) return 1.0;
    vec2 co = abs(uv - 0.5) * 2.0;
    float r = corners * 0.5;
    vec2 d = max(co - (1.0 - r), 0.0);
    float dist = length(d) / max(r, 0.001);
    return 1.0 - smoothstep(0.75, 1.0, dist);
}

void main(){
    vec2 uv = barrel(vUv);
    uv = applyOverscan(uv);
    uv = analogWarp(uv);

    if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){
        discard;
    }

    vec3 color = beam(uv);
    color = mix(color, rgbSample(uv), 0.5);

    color *= scan(vUv);
    color *= mix(1.0, mask(vUv), maskStrength);

    color *= brightness;
    color = (color - 0.5) * contrast + 0.5;

    color += color * halation * 0.05;

    float v = distance(uv, vec2(0.5));
    color *= 1.0 - v * vignette;

    color *= cornerMask(uv);

    if(reflection > 0.0){
        float glare = pow(max(0.0, 1.0 - distance(uv, vec2(0.32, 0.24)) * 1.6), 2.0);
        color += glare * reflection * 0.18;
    }

    color += (hash(uv * uTime) - 0.5) * noise;

    if (color_quantization > 1.0) {
        float levels = color_quantization - 1.0;
        color = floor(clamp(color, 0.0, 1.0) * levels + 0.5) / levels;
    }

    color *= color_tint;

    gl_FragColor = vec4(color, 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createCrtShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uResolution: { value: [1, 1] },
      curve: { value: 0.08 },
      overscan: { value: 0.02 },
      corners: { value: 0.08 },
      beamWidth: { value: 0.6 },
      beamSharpness: { value: 2.0 },
      smear: { value: 0.3 },
      maskStrength: { value: 0.3 },
      subpixelSize: { value: 3.0 },
      maskType: { value: 0 },
      scanlines: { value: 0.35 },
      halation: { value: 0.15 },
      convergence: { value: 0.6 },
      bleed: { value: 0.2 },
      tracking: { value: 0 },
      noise: { value: 0.02 },
      jitter: { value: 0 },
      roll: { value: 0 },
      reflection: { value: 0.15 },
      vignette: { value: 0.35 },
      brightness: { value: 1.0 },
      contrast: { value: 1.05 },
      color_tint: { value: [1, 1, 1] },
      color_quantization: { value: 0 },
    },
    vertexShader: crtVertexShader,
    fragmentShader: crtFragmentShader,
  };
}

// Named presets rather than exposing ~20 raw sliders by default - matches
// how the rest of the app already prefers a small set of named options
// (tone-mapping dropdown, up-axis presets) over an unlabelled wall of
// controls. Each is a full uniform set, applied wholesale.
export const CRT_PRESETS = {
  arcade: {
    curve: 0.12, overscan: 0.03, corners: 0.12,
    beamWidth: 0.7, beamSharpness: 2.2, smear: 0.2,
    maskStrength: 0.45, subpixelSize: 3.0, maskType: 0,
    scanlines: 0.45, halation: 0.1, convergence: 0.4, bleed: 0.1,
    tracking: 0, noise: 0.015, jitter: 0, roll: 0,
    reflection: 0.2, vignette: 0.4, brightness: 1.05, contrast: 1.1,
    color_tint: [1, 1, 1], color_quantization: 0,
  },
  vhs: {
    curve: 0.04, overscan: 0.01, corners: 0.04,
    beamWidth: 0.5, beamSharpness: 1.6, smear: 0.8,
    maskStrength: 0.1, subpixelSize: 3.0, maskType: 1,
    scanlines: 0.2, halation: 0.25, convergence: 1.2, bleed: 0.9,
    tracking: 0.6, noise: 0.05, jitter: 0.4, roll: 0.3,
    reflection: 0.05, vignette: 0.25, brightness: 1.0, contrast: 0.95,
    color_tint: [1.0, 0.98, 0.9], color_quantization: 0,
  },
  oldtv: {
    curve: 0.06, overscan: 0.02, corners: 0.15,
    beamWidth: 0.6, beamSharpness: 1.8, smear: 0.15,
    maskStrength: 0, subpixelSize: 3.0, maskType: 0,
    scanlines: 0.25, halation: 0.3, convergence: 0.3, bleed: 0.15,
    tracking: 0, noise: 0.03, jitter: 0, roll: 0,
    reflection: 0.25, vignette: 0.5, brightness: 0.95, contrast: 0.9,
    color_tint: [1.0, 0.95, 0.85], color_quantization: 0,
  },
};

export function applyCrtPreset(pass, name) {
  const preset = CRT_PRESETS[name];
  if (!preset || !pass) return;
  for (const [key, value] of Object.entries(preset)) {
    if (pass.uniforms[key]) pass.uniforms[key].value = value;
  }
}
