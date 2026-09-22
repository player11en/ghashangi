// Pixel sort: the signature glitch-art technique.
//
// Be precise about what this is, because "pixel sort" usually means something
// slightly different and the difference is visible.
//
// The classic technique sorts *arbitrarily long runs* - it walks a row, finds
// spans where luminance crosses a threshold, and fully sorts each span however
// long it happens to be. That is a variable-length sort per row, which on a GPU
// means multi-pass bitonic sorting with ping-pong buffers: log2(n)^2 passes,
// each a full-screen draw, plus the render targets to bounce between.
//
// This is a *window-limited* sort instead: for each pixel, the pixels within a
// bounded window along the sort axis are genuinely ranked, and the one whose
// rank matches this pixel's position in the window is output. Inside the
// window the result is a true sort, not a blur or a smear standing in for one.
// The visible difference from the classic version is that streaks stop at the
// window length rather than running the width of the frame.
//
// The selection is done by binary search on luminance rather than by comparing
// every pair: eight steps, each counting how many samples in the window fall
// below a candidate value, converges on the value with the wanted rank. That
// turns an O(n^2) sort into O(8n) - at window 32 roughly 256 samples per pixel,
// which is the same order as Kuwahara at its maximum radius and carries the
// same "turn this down first" warning.
//
// The threshold is what makes it read as glitch art rather than as a gradient:
// only pixels on one side of it participate, so sorted bands tear out of the
// image along edges instead of smearing the whole frame uniformly.

const pixelSortVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

/** Window length in pixels. The loop bound has to be a compile-time constant. */
const MAX_WINDOW = 48;

const pixelSortFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float windowSize;
// Only pixels whose luminance is inside [low, high] take part. Everything else
// passes through untouched, which is what produces torn bands rather than a
// uniformly smeared frame.
uniform float lowThreshold;
uniform float highThreshold;
uniform float vertical;
uniform float reverse;
uniform float strength;

varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
    vec3 source = texture2D(tDiffuse, vUv).rgb;
    float sourceLuma = luma(source);

    // Outside the band: leave it alone.
    if (sourceLuma < lowThreshold || sourceLuma > highThreshold){
        gl_FragColor = vec4(source, 1.0);
        return;
    }

    vec2 axis = vertical > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
    vec2 texel = axis / uResolution;

    float window = max(windowSize, 2.0);
    vec2 pixel = vUv * uResolution;
    float position = vertical > 0.5 ? pixel.y : pixel.x;

    // Where this pixel sits inside its window, and where the window starts.
    float indexInWindow = mod(floor(position), window);
    vec2 windowStart = vUv - texel * indexInWindow;

    // The rank we want: position in window, or its mirror when reversed.
    float wantedRank = reverse > 0.5 ? (window - 1.0 - indexInWindow) : indexInWindow;

    // Binary search on luminance for the value with that rank. Eight steps
    // resolves 1/256, which is the precision of the 8-bit source anyway.
    float low = 0.0;
    float high = 1.0;
    for (int step = 0; step < 8; step++){
        float mid = (low + high) * 0.5;
        float countBelow = 0.0;
        float participating = 0.0;

        for (int i = 0; i < ${MAX_WINDOW}; i++){
            if (float(i) >= window) break;
            vec3 c = texture2D(tDiffuse, clamp(windowStart + texel * float(i), 0.0005, 0.9995)).rgb;
            float l = luma(c);
            // Non-participating pixels are excluded from the ranking so the
            // sort operates on the band alone, not on the whole window.
            if (l >= lowThreshold && l <= highThreshold){
                participating += 1.0;
                if (l < mid) countBelow += 1.0;
            }
        }

        // Clamp the target rank to what the window actually contains, or a
        // mostly-excluded window would always resolve to its extreme.
        float target = min(wantedRank, max(participating - 1.0, 0.0));
        if (countBelow <= target) low = mid; else high = mid;
    }

    float targetLuma = (low + high) * 0.5;

    // Second pass over the window to fetch the colour closest to that
    // luminance - the sort is on luminance, but what gets drawn is a real
    // pixel from the source, so colour relationships survive.
    vec3 best = source;
    float bestDelta = 1e9;
    for (int i = 0; i < ${MAX_WINDOW}; i++){
        if (float(i) >= window) break;
        vec3 c = texture2D(tDiffuse, clamp(windowStart + texel * float(i), 0.0005, 0.9995)).rgb;
        float l = luma(c);
        if (l < lowThreshold || l > highThreshold) continue;
        float delta = abs(l - targetLuma);
        if (delta < bestDelta){
            bestDelta = delta;
            best = c;
        }
    }

    gl_FragColor = vec4(mix(source, best, strength), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createPixelSortShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      windowSize: { value: 24 },
      lowThreshold: { value: 0.25 },
      highThreshold: { value: 0.8 },
      vertical: { value: 0 },
      reverse: { value: 0 },
      strength: { value: 1 },
    },
    vertexShader: pixelSortVertexShader,
    fragmentShader: pixelSortFragmentShader,
  };
}

export { MAX_WINDOW as PIXEL_SORT_MAX_WINDOW };
