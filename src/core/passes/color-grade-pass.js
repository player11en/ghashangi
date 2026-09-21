// Color grading pass: basic Color Correction (brightness/contrast/
// saturation/hue) always active once enabled, plus a style dropdown for
// Duotone / Hue Cycle / Rainbow - the Track 2 "LUT" sketch item, finally
// built, in the same "one pass, mode uniform" shape as the other Style
// passes rather than a fourth separate effect toggle.

const colorGradeVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const colorGradeFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float hueOffset;
uniform float style; // 0 none (plain correction), 1 duotone, 2 hue cycle, 3 rainbow
uniform vec3 lightColor;
uniform vec3 darkColor;
uniform float uTime;
uniform float speed;

varying vec2 vUv;

vec3 rgb2hsv(vec3 c){
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c){
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
    vec3 color = texture2D(tDiffuse, vUv).rgb;

    color *= brightness;
    color = (color - 0.5) * contrast + 0.5;
    color = mix(vec3(luma(color)), color, saturation);

    float hueAnim = (style > 1.5 && style < 2.5) ? uTime * speed * 0.1 : 0.0;
    vec3 hsv = rgb2hsv(clamp(color, 0.0, 1.0));
    hsv.x = fract(hsv.x + hueOffset + hueAnim);
    color = hsv2rgb(hsv);

    if (style > 0.5 && style < 1.5) {
        // Duotone: map luminance onto a ramp between two colors.
        color = mix(darkColor, lightColor, luma(color));
    } else if (style > 2.5) {
        // Rainbow/thermal: map luminance to a hue ramp instead of a color ramp.
        float l = luma(color);
        float hue = fract(l + uTime * speed * 0.05);
        color = hsv2rgb(vec3(hue, 1.0, l));
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createColorGradeShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      brightness: { value: 1 },
      contrast: { value: 1 },
      saturation: { value: 1 },
      hueOffset: { value: 0 },
      style: { value: 0 },
      lightColor: { value: [1, 0.9, 0.6] },
      darkColor: { value: [0.05, 0.05, 0.2] },
      uTime: { value: 0 },
      speed: { value: 1 },
    },
    vertexShader: colorGradeVertexShader,
    fragmentShader: colorGradeFragmentShader,
  };
}

export const COLOR_GRADE_STYLES = { none: 0, duotone: 1, huecycle: 2, rainbow: 3 };

export function setColorGradeStyle(pass, name) {
  const style = COLOR_GRADE_STYLES[name];
  if (style === undefined || !pass) return;
  pass.uniforms.style.value = style;
}
