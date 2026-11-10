// Shared plumbing for every render module: theme uniforms, the GLSL print library
// (world-anchored halftone / hatch with distance LOD) and the material factory.
//
// The whole renderer draws into a two-attachment target:
//   location 0 "color plate": rgb = paper/spot/player inks, a = 1 when the pixel belongs to spot plate B
//   location 1 "line plate":  rgb = world normal * .5 + .5,  a = dark line-ink coverage
// post.js prints the plates on top of each other, slightly out of register.
import * as THREE from 'three';

export const SUN_DIR = new THREE.Vector3(0.5, 0.78, 0.37).normalize();

// Depth is split so the first-person viewmodel can live in the same buffers as the world
// (and get the same outlines/misregistration) without ever clipping into walls:
// world uses window depth [0.1, 1], viewmodel [0, 0.1]. Stored as (scale, offset) on clip z.
export const DEPTH_WORLD = { value: new THREE.Vector2(0.9, 0.1) };
export const DEPTH_VIEW = { value: new THREE.Vector2(0.1, -0.9) };

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function setHex(vec3, hex) {
  const c = hexToRgb(hex);
  return vec3.set(c[0], c[1], c[2]);
}

// Uniform objects shared BY REFERENCE between all materials: change once, every shader sees it.
export const shared = {
  uTime: { value: 0 },
  uPaper: { value: new THREE.Vector3(0.95, 0.91, 0.84) },
  uInk: { value: new THREE.Vector3(0.1, 0.1, 0.12) },
  uSpotA: { value: new THREE.Vector3(0.18, 0.42, 1) },
  uSpotB: { value: new THREE.Vector3(1, 0.28, 0.69) },
  uSky: { value: new THREE.Vector3(0.97, 0.85, 0.9) },
  uSunDir: { value: SUN_DIR },
  uLod: { value: 0.02 },                             // world meters per meter of distance for one pattern period
  uFog: { value: new THREE.Vector3(38, 120, 0.55) }, // start, end, max amount
};

export function applyTheme(theme) {
  setHex(shared.uPaper.value, theme.paper);
  setHex(shared.uInk.value, theme.ink);
  setHex(shared.uSpotA.value, theme.a);
  setHex(shared.uSpotB.value, theme.b);
  setHex(shared.uSky.value, theme.sky);
}

export const GLSL_LIB = /* glsl */`
uniform float uTime;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uSpotA;
uniform vec3 uSpotB;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform float uLod;
uniform vec3 uFog;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

// Pick the 2D pattern plane from the surface normal: patterns stick to the surface, never to the screen.
vec2 planar(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.y >= a.x && a.y >= a.z ? p.xz : (a.x > a.z ? p.zy : p.xy);
}

// Pattern period grows in octaves with distance so the print screen keeps a roughly constant
// frequency on the monitor, while every octave stays anchored in world space.
// returns (period in meters, blend 0..1 toward the next octave)
vec2 lodOf(float dist) {
  float e = max(log2(uLod * dist / 0.03), 0.0);
  float l = floor(e);
  return vec2(0.03 * exp2(l), e - l);
}
// Distance used for pattern LOD: true distance, stretched a little at grazing angles so floors
// keep readable dots for longer. Depends on camera POSITION only, so patterns never swim on mouselook.
float lodDist(vec3 wp, vec3 n) {
  vec3 v = wp - cameraPosition;
  float d = length(v);
  return d / clamp(abs(dot(v, n)) / d, 0.4, 1.0);
}
float aaWidth(vec2 p) { return 0.7 * length(vec2(fwidth(p.x), fwidth(p.y))); }

float dotLattice(vec2 p, float period, float cov, float aaW) {
  vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p / period;
  float r = sqrt(clamp(cov, 0.0, 1.0) * 0.3183);
  float aa = aaW / period;
  float m = (1.0 - smoothstep(r - aa, r + aa, length(fract(q) - 0.5))) * smoothstep(0.0, 0.03, cov);
  return mix(m, cov, smoothstep(0.16, 0.36, aa));     // too fine to resolve: print the flat tint instead
}
// Halftone dots; cov = ink coverage 0..1.
float halftone(vec2 p, float dist, float cov) {
  vec2 L = lodOf(dist);
  float aaW = aaWidth(p);
  float f = smoothstep(0.0, 1.0, L.y);
  float a = dotLattice(p, L.x, cov * (1.0 - f), aaW);
  float b = dotLattice(p, L.x * 2.0, cov * f, aaW);
  return max(a, b);
}
float lineLattice(float x, float period, float cov, float aaW) {
  float l = abs(fract(x / period) - 0.5) * 2.0;
  float aa = 2.0 * aaW / period;
  float m = (1.0 - smoothstep(cov - aa, cov + aa, l)) * smoothstep(0.0, 0.03, cov);
  return mix(m, cov, smoothstep(0.32, 0.72, aa));
}
// Diagonal line hatching; dir = +1 / -1 picks the diagonal.
float hatch(vec2 p, float dist, float cov, float dir) {
  vec2 L = lodOf(dist);
  float aaW = aaWidth(p);
  float x = (p.x + dir * p.y) * 0.7071;
  float f = smoothstep(0.0, 1.0, L.y);
  float a = lineLattice(x, L.x, cov * (1.0 - f), aaW);
  float b = lineLattice(x, L.x * 2.0, cov * f, aaW);
  return max(a, b);
}
float fogAmt(float dist) { return smoothstep(uFog.x, uFog.y, dist) * uFog.z; }

// antialiased step for meter-space decoration: 1 where x < edge
float below(float x, float edge) { float w = fwidth(x) * 0.75 + 1e-5; return 1.0 - smoothstep(edge - w, edge + w, x); }
float band(float x, float lo, float hi) { return below(x, hi) * (1.0 - below(x, lo)); }
`;

export const VERT_LIB = /* glsl */`
uniform float uTime;
uniform vec2 uDepthMap;
void placeDepth() { gl_Position.z = gl_Position.z * uDepthMap.x + uDepthMap.y * gl_Position.w; }
`;

export const FRAG_LIB = /* glsl */`
layout(location = 1) out highp vec4 gLine;
${GLSL_LIB}
void emit(vec3 color, float plateB, float ink, vec3 n) {
  gl_FragColor = vec4(color, plateB);
  gLine = vec4(n * 0.5 + 0.5, ink);
}
// for 'over' materials: alpha-over colour, knock = how much line ink underneath is removed
void emitOver(vec3 color, float alpha, float knock) {
  gl_FragColor = vec4(color, alpha);
  gLine = vec4(0.5, 0.5, 0.5, knock);
}
`;

// blend:
//   'opaque'   — writes both plates
//   'over'     — alpha-over on the color plate, and knocks the line ink out underneath (wet ink on top of the print)
//   'inkAdd'   — only adds line ink (blob shadows)
export function inkMaterial({ vertex, fragment, uniforms = {}, viewmodel = false, blend = 'opaque', ...rest }) {
  const m = new THREE.ShaderMaterial({
    uniforms: { ...shared, uDepthMap: viewmodel ? DEPTH_VIEW : DEPTH_WORLD, ...uniforms },
    vertexShader: VERT_LIB + vertex,
    fragmentShader: FRAG_LIB + fragment,
    ...rest,
  });
  if (blend === 'over') {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  } else if (blend === 'inkAdd') {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
  }
  return m;
}

let fontsReady = null;
/** Loads the vendored display fonts for canvas drawing. Never rejects: canvases fall back to system fonts. */
export function loadFonts() {
  if (fontsReady) return fontsReady;
  const want = [
    ['Dela Gothic One', '/fonts/dela-gothic-one-latin-400-normal.woff2', '400'],
    ['Archivo Black', '/fonts/archivo-black-latin-400-normal.woff2', '400'],
    ['Archivo Narrow', '/fonts/archivo-narrow-latin-700-normal.woff2', '700'],
    ['DM Mono', '/fonts/dm-mono-latin-500-normal.woff2', '500'],
  ];
  fontsReady = Promise.all(want.map(async ([family, url, weight]) => {
    try {
      const face = new FontFace(family, `url(${url})`, { weight });
      document.fonts.add(await face.load());
    } catch { /* fall back to system fonts */ }
  }));
  return fontsReady;
}
export const FONT_DISPLAY = "'Dela Gothic One', 'Archivo Black', Impact, sans-serif";
export const FONT_HEAVY = "'Archivo Black', Impact, 'Arial Black', sans-serif";
export const FONT_NARROW = "700 %px 'Archivo Narrow', 'Arial Narrow', sans-serif";
export const FONT_MONO = "500 %px 'DM Mono', ui-monospace, monospace";

/** Unit quad as a fullscreen/billboard base: 4 verts in [-1,1]², uv in [0,1]². */
export function quadGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
