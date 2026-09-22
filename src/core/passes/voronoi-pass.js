// Voronoi / cellular: shatter, stained glass and mosaic from one cell shader.
//
// All three modes share the same first step - work out which of a scattered set
// of cell points each pixel belongs to - and differ only in what they do with
// that answer. Mosaic paints the cell its centre's colour, stained glass does
// that and draws the boundaries, and shatter offsets each cell's lookup so the
// image breaks into displaced shards.
//
// The cell points come from hashing the integer grid coordinate rather than
// from a uniform array of points. That is what keeps it a single pass with no
// buffers: a real Voronoi diagram over N sites is a nearest-neighbour search,
// but jittering one point per grid cell and searching only the 3x3 neighbours
// gives the same look for a bounded nine texture-free iterations per pixel.
// The tradeoff is that cells are roughly grid-sized rather than arbitrarily
// distributed, which for a stylization pass is invisible.

const voronoiVertexShader = `
varying vec2 vUv;
void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`;

const voronoiFragmentShader = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float cellSize;
// How far each cell point strays from its grid slot. 0 is a plain square grid;
// 1 lets points reach the edges of their cell, which reads as organic.
uniform float jitter;
uniform float mode;      // 0 mosaic, 1 stained glass, 2 shatter
uniform float edgeWidth;
uniform vec3 edgeColor;
uniform float shatter;
uniform float time;

varying vec2 vUv;

// Cheap 2D hash. Not high quality, but it only has to be stable per cell and
// free of visible axis alignment.
vec2 hash2(vec2 p){
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

void main(){
    vec2 pixel = vUv * uResolution;
    vec2 grid = pixel / max(cellSize, 2.0);
    vec2 cell = floor(grid);
    vec2 local = fract(grid);

    // Nearest and second-nearest site, searched over the 3x3 neighbourhood.
    // The second is what makes the boundary drawable: the difference between
    // the two distances is near zero exactly on an edge.
    float best = 8.0;
    float second = 8.0;
    vec2 bestCell = cell;
    vec2 bestOffset = vec2(0.0);

    for (int y = -1; y <= 1; y++){
        for (int x = -1; x <= 1; x++){
            vec2 neighbour = vec2(float(x), float(y));
            vec2 point = hash2(cell + neighbour);
            // Drift the points over time so the pattern can animate with the
            // rest of the chain rather than sitting frozen on a moving image.
            point = 0.5 + (point - 0.5) * jitter;
            point += 0.06 * jitter * vec2(sin(time + point.x * 6.2831), cos(time + point.y * 6.2831));

            vec2 delta = neighbour + point - local;
            float dist = dot(delta, delta);

            if (dist < best){
                second = best;
                best = dist;
                bestCell = cell + neighbour;
                bestOffset = neighbour + point;
            } else if (dist < second){
                second = dist;
            }
        }
    }

    // Sample at the winning cell's centre so the whole cell shares one colour.
    vec2 centreUv = ((cell + bestOffset) * max(cellSize, 2.0)) / uResolution;

    if (mode > 1.5){
        // Shatter: push each cell's lookup along its own pseudo-random
        // direction, so the picture breaks into displaced shards instead of
        // being flattened into facets.
        vec2 dir = hash2(bestCell + 17.0) - 0.5;
        centreUv += dir * shatter * 0.2;
    }

    vec3 color = texture2D(tDiffuse, clamp(centreUv, 0.001, 0.999)).rgb;

    if (mode > 0.5 && mode < 1.5){
        // Stained glass: darken the seam where the two nearest sites tie.
        float edge = sqrt(second) - sqrt(best);
        float line = smoothstep(0.0, max(edgeWidth, 0.001), edge);
        color = mix(edgeColor, color, line);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

export const VORONOI_MODES = ['mosaic', 'glass', 'shatter'];

/** Shape ShaderPass expects: { uniforms, vertexShader, fragmentShader }. */
export function createVoronoiShader() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: [1, 1] },
      cellSize: { value: 28 },
      jitter: { value: 0.85 },
      mode: { value: 0 },
      edgeWidth: { value: 0.08 },
      edgeColor: { value: [0.02, 0.02, 0.04] },
      shatter: { value: 0.35 },
      time: { value: 0 },
    },
    vertexShader: voronoiVertexShader,
    fragmentShader: voronoiFragmentShader,
  };
}

/** @param {string} name One of VORONOI_MODES. */
export function setVoronoiMode(pass, name) {
  const index = VORONOI_MODES.indexOf(name);
  pass.uniforms.mode.value = index === -1 ? 0 : index;
}
