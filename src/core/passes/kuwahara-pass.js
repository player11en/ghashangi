// Kuwahara: the painterly / oil-paint filter.
//
// An edge-preserving smoother, which is what makes it look like brushwork
// rather than blur. For each pixel it splits the neighbourhood into four
// overlapping quadrants, measures the variance of each, and takes the mean of
// whichever quadrant is flattest. Inside a flat region every quadrant agrees
// and the result is a smooth average; on an edge, the quadrant that does not
// straddle it wins, so the edge stays sharp and the colour on each side gets
// flattened into a stroke.
//
// Cost is the thing to watch: this samples radius^2 texels per quadrant, so
// it is O(r^2) per pixel with no way around it. At radius 8 that is ~324
// samples per pixel, which is why the radius is capped in the UI rather than
// left open - and why this is the one Style pass with a real warning attached
// to turning it up on a weak device.

const kuwaharaVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

// The quadrant loops need a compile-time constant bound, so the shader is
// built around MAX_RADIUS and the live `radius` uniform breaks out early.
const MAX_RADIUS = 8;

const kuwaharaFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float radius;
// Blends the result back toward the source, so the effect has a strength dial
// rather than being all-or-nothing.
uniform float strength;
// Pushes the chosen quadrant's mean away from the overall mean, which
// exaggerates the flat-colour-patch look into something closer to paint.
uniform float punch;

varying vec2 vUv;

void main(){
    vec2 texel = 1.0 / uResolution;
    int r = int(min(radius, ${MAX_RADIUS}.0));

    vec3 bestMean = vec3(0.0);
    float bestVariance = 1e9;
    vec3 overallMean = vec3(0.0);
    float overallCount = 0.0;

    // Four overlapping quadrants: (-r..0, -r..0), (0..r, -r..0), and so on.
    for (int q = 0; q < 4; q++){
        vec2 dir = vec2(q == 0 || q == 2 ? -1.0 : 1.0, q < 2 ? -1.0 : 1.0);

        vec3 sum = vec3(0.0);
        vec3 sumSq = vec3(0.0);
        float count = 0.0;

        for (int y = 0; y <= ${MAX_RADIUS}; y++){
            if (y > r) break;
            for (int x = 0; x <= ${MAX_RADIUS}; x++){
                if (x > r) break;
                vec2 offset = vec2(float(x), float(y)) * dir * texel;
                vec3 c = texture2D(tDiffuse, clamp(vUv + offset, 0.001, 0.999)).rgb;
                sum += c;
                sumSq += c * c;
                count += 1.0;
            }
        }

        vec3 mean = sum / count;
        // Variance per channel, summed: E[x^2] - E[x]^2.
        vec3 variance = abs(sumSq / count - mean * mean);
        float score = variance.r + variance.g + variance.b;

        overallMean += mean;
        overallCount += 1.0;

        if (score < bestVariance){
            bestVariance = score;
            bestMean = mean;
        }
    }

    overallMean /= overallCount;

    vec3 painted = bestMean + (bestMean - overallMean) * punch;
    vec3 source = texture2D(tDiffuse, vUv).rgb;

    gl_FragColor = vec4(mix(source, clamp(painted, 0.0, 1.0), strength), 1.0);
}
`;

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createKuwaharaShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      radius: { value: 4 },
      strength: { value: 1 },
      punch: { value: 0.3 },
    },
    vertexShader: kuwaharaVertexShader,
    fragmentShader: kuwaharaFragmentShader,
  };
}

export { MAX_RADIUS as KUWAHARA_MAX_RADIUS };
