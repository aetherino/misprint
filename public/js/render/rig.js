// Shader + material factory for "rigs": merged primitive models animated by a small matrix palette
// (characters, the first-person viewmodel, pickups). One draw call per rig, plus one for its ink rim.
import * as THREE from 'three';
import { inkMaterial, SUN_DIR } from './common.js';

const VERT = /* glsl */`
uniform mat4 uPart[NPARTS];
uniform vec2 uHull;        // rim thickness: (min meters, meters per meter of view depth)
attribute float aPart;
attribute float aPal;
attribute vec3 aOut;
varying vec3 vL;
varying vec3 vLN;
varying vec3 vN;
varying vec3 vW;
varying float vPal;
varying vec2 vUv;
void main() {
  mat4 pm = uPart[int(aPart + 0.5)];
  vec3 lp = (pm * vec4(position, 1.0)).xyz;
  vec3 ln = normalize(mat3(pm) * normal + 1e-6);
  vL = lp; vLN = ln; vPal = aPal; vUv = uv;
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vN = normalize(mat3(modelMatrix) * ln);
#ifdef HULL
  vec3 od = normalize(mat3(modelMatrix) * (mat3(pm) * aOut) + 1e-6);
  wp.xyz += od * max(uHull.x, uHull.y * -(viewMatrix * wp).z);
#endif
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  placeDepth();
}
`;

const HEAD = /* glsl */`
uniform vec3 uTint;
uniform vec3 uLight;
uniform sampler2D uFace;
uniform float uCharge;
uniform float uHurt;
uniform vec2 uPrint;       // (cut height in rig space, enabled)
uniform float uDotScale;
varying vec3 vL;
varying vec3 vLN;
varying vec3 vN;
varying vec3 vW;
varying float vPal;
varying vec2 vUv;
// "printed line by line": everything above the print head is not on the page yet
float printCut() {
  if (uPrint.y < 0.5) return 0.0;
  float wob = 0.012 * sin(vL.x * 40.0 + uTime * 30.0);
  if (vL.y > uPrint.x + wob) discard;
  return step(uPrint.x + wob - 0.05, vL.y);
}
`;

const BODY_FRAG = HEAD + /* glsl */`
void main() {
  float scan = printCut();
  vec3 n = normalize(vN);
  float dist = length(vW - cameraPosition);
  vec2 p = planar(vL, normalize(vLN)) * uDotScale;
  float ndl = dot(n, uLight);
  float dark = n.y > 0.75 ? 0.0 : (ndl > 0.3 ? 0.0 : (ndl > -0.2 ? 0.3 : 0.62));
  vec3 white = mix(uPaper, vec3(1.0), 0.35);
  vec3 col; float ink = 0.0;
  if (vPal < 0.5) {                 // player ink: solid, line-ink dots in shade
    col = uTint; ink = halftone(p, dist, dark * 0.55);
  } else if (vPal < 1.5) {          // paper parts shade with dots of the player's own ink
    col = mix(white, uTint, halftone(p, dist, dark * 0.5));
  } else if (vPal < 2.5) {          // dark ink
    col = white; ink = 1.0;
  } else if (vPal < 3.5) {          // CRT face
    float on = texture2D(uFace, vUv).r;
    vec2 cell = fract(vUv * vec2(16.0, 12.0));
    float gap = min(1.0, fwidth(vUv.x * 16.0) * 3.0);
    on *= mix(step(0.1, cell.x) * step(0.1, cell.y), 0.85, gap);
    col = mix(uTint, vec3(1.0), 0.22 + 0.78 * uHurt);
    ink = (1.0 - on) * 0.94;
  } else if (vPal < 4.5) {          // accent: player ink, overprinted darker
    col = mix(uTint, uInk, 0.38); ink = halftone(p, dist, dark * 0.5);
  } else if (vPal < 5.5) {          // metal: grey stock with hatch
    col = mix(white, uInk, 0.26); ink = hatch(p, dist, 0.12 + dark * 0.45, 1.0);
  } else if (vPal < 6.5) {          // glow: wet ink, brightens with charge
    float pulse = 0.5 + 0.5 * sin(uTime * 22.0);
    col = mix(uTint, vec3(1.0), clamp(uCharge * (0.55 + 0.3 * pulse), 0.0, 0.9));
    ink = halftone(p, dist, dark * 0.4 * (1.0 - uCharge));
  } else {                          // arena spot ink
    col = uSpotA; ink = halftone(p, dist, dark * 0.5);
  }
  col = mix(col, vec3(1.0), uHurt * 0.75);
  ink *= 1.0 - uHurt;
  col = mix(col, white, scan); ink *= 1.0 - scan;
  float f = fogAmt(dist);
  emit(mix(col, uPaper, f * 0.6), 0.0, ink * (1.0 - 0.6 * f), n);
}
`;

const HULL_FRAG = HEAD + /* glsl */`
void main() {
  printCut();
  emit(mix(uTint, vec3(1.0), uHurt), 0.0, 0.0, vec3(0.0));
}
`;

const GHOST_FRAG = HEAD + /* glsl */`
uniform float uGhost;
void main() {
  // watermark: faint diagonal laid lines, a touch stronger where the surface turns away
  vec3 v = normalize(cameraPosition - vW);
  float rim = 1.0 - abs(dot(normalize(vN), v));
  float lines = step(0.5, fract((vL.x + vL.y * 1.3) * 14.0));
  float a = uGhost * (0.25 + 0.75 * lines) * (0.6 + 0.9 * rim);
  if (hash21(floor(gl_FragCoord.xy)) > 0.7 + 0.3 * lines) discard;
  emitOver(mix(uInk, uPaper, 0.5), a, 0.0);
}
`;

const VIEW_LIGHT = new THREE.Vector3(-0.42, 0.78, 0.46).normalize();

/**
 * kind: 'body' | 'hull' | 'ghost'.  uniforms are shared between the kinds of one rig (pass the same object).
 * Returns a material; `makeRigUniforms` builds the per-rig uniform block.
 */
export function makeRigUniforms(parts, { viewmodel = false, dotScale = 1 } = {}) {
  return {
    uPart: { value: new Float32Array(16 * parts) },
    uTint: { value: new THREE.Vector3(1, 0.3, 0.7) },
    uLight: { value: viewmodel ? VIEW_LIGHT : SUN_DIR },
    uFace: { value: null },
    uCharge: { value: 0 },
    uHurt: { value: 0 },
    uPrint: { value: new THREE.Vector2(0, 0) },
    uDotScale: { value: dotScale },
    uHull: { value: new THREE.Vector2(0.02, 0.0036) },
    uGhost: { value: 0.22 },
  };
}

export function rigMaterial(kind, parts, uniforms, viewmodel = false) {
  const defines = { NPARTS: parts };
  if (kind === 'hull') {
    return inkMaterial({ vertex: VERT, fragment: HULL_FRAG, uniforms, viewmodel, defines: { ...defines, HULL: 1 }, side: THREE.BackSide });
  }
  if (kind === 'ghost') {
    return inkMaterial({ vertex: VERT, fragment: GHOST_FRAG, uniforms, viewmodel, defines, blend: 'over' });
  }
  return inkMaterial({ vertex: VERT, fragment: BODY_FRAG, uniforms, viewmodel, defines });
}
