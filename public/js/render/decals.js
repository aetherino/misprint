// Ink splats: the arena gets painted. A single instanced draw of up to MAX procedural splats
// (oldest recycled), each oriented to its surface, clipped to the box face it landed on, with drips on walls.
// Ink sits nearly opaque (so the shooter's colour stays readable on any surface, including black walls,
// where it knocks the line ink out) with a pooled darker rim and a slightly translucent mottled body, so
// layered splats still read as overprinted wet ink. (A true MIN/darken overprint was tried: authentic,
// but hot spots hit by many colours turn to mud.)
import * as THREE from 'three';
import { INKS } from '/shared/constants.js';
import { inkMaterial, hexToRgb, quadGeometry } from './common.js';

const MAX = 600;
const STRIDE = 18;   // center3 normal3 shape4(size, rot, seed, birth) col4(rgb, drip) clip4

const VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aNormal;
attribute vec4 aShape;
attribute vec4 aCol;
attribute vec4 aClip;
varying vec2 vQ;
varying vec4 vShape;
varying vec4 vCol;
varying vec4 vClip;
varying vec3 vW;
varying vec3 vN;
void main() {
  vec3 n = aNormal;
  vec3 T = abs(n.y) > 0.7 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 B = cross(n, T);
  vec2 q = position.xy * 1.45;
  if (position.y < 0.0) q.y -= aCol.a * 2.7;       // room for drips
  q *= aShape.x;
  vQ = q; vShape = aShape; vCol = aCol; vClip = aClip; vN = n;
  vW = aCenter + T * q.x + B * q.y + n * 0.014;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
  placeDepth();
}
`;

const FRAG = /* glsl */`
varying vec2 vQ;
varying vec4 vShape;
varying vec4 vCol;
varying vec4 vClip;
varying vec3 vW;
varying vec3 vN;
void main() {
  if (vQ.x < vClip.x || vQ.y < vClip.y || vQ.x > vClip.z || vQ.y > vClip.w) discard;
  float seed = vShape.z;
  float age = uTime - vShape.w;
  float grow = 1.0 - exp(-age * 28.0);
  vec2 q = vQ / vShape.x;
  float cr = cos(vShape.y), sr = sin(vShape.y);
  vec2 p = mat2(cr, sr, -sr, cr) * q;
  float a = atan(p.y, p.x), r = length(p);
  // blobby core with a few thrown rays
  float R = 0.56 + 0.1 * sin(a * 3.0 + seed * 6.0) + 0.07 * sin(a * 5.0 + seed * 11.0) + 0.045 * sin(a * 9.0 + seed * 23.0);
  R += 0.42 * pow(max(0.0, sin(a * (2.0 + floor(seed * 4.0)) + seed * 40.0)), 7.0);
  float d = r - R * grow;
  // satellite droplets
  for (int i = 0; i < 5; i++) {
    float fi = float(i) + seed * 17.0;
    float da = hash11(fi) * 6.283, dr = 0.9 + 0.42 * hash11(fi + 3.1), ds = 0.035 + 0.075 * hash11(fi + 7.7);
    d = min(d, length(p - vec2(cos(da), sin(da)) * dr * grow) - ds);
  }
  // drips creep down walls while the ink is wet
  if (vCol.a > 0.0) {
    float len = vCol.a * (1.0 - exp(-age * 1.4));
    for (int i = 0; i < 3; i++) {
      float fi = float(i) * 5.3 + seed * 31.0;
      float x = (hash11(fi) - 0.5) * 0.8;
      float w = 0.04 + 0.04 * hash11(fi + 1.7);
      float L = len * (0.5 + 2.0 * hash11(fi + 4.2));
      vec2 pd = q - vec2(x, 0.0);
      float along = clamp(-pd.y, 0.0, L);
      d = min(d, length(vec2(pd.x, pd.y + along)) - w * (0.75 + 0.55 * smoothstep(L - 0.2, L, along)));
    }
  }
  float aa = fwidth(d) + 1e-4;
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.01) discard;
  // wet ink: denser pooled rim, uneven body, a few gloss specks while fresh
  float rim = smoothstep(-0.16, -0.03, d);
  float mott = vnoise(vQ * 8.0 + seed * 50.0);
  float gloss = step(0.82, vnoise(vQ * 5.0 + seed * 9.0 + 3.0)) * (1.0 - rim) * exp(-age * 0.5);
  float dens = clamp(0.88 + 0.12 * rim - 0.14 * mott * (1.0 - rim) - 0.4 * gloss, 0.0, 1.0);
  vec3 ink = vCol.rgb * mix(1.0, 0.84, rim);
  float f = fogAmt(length(vW - cameraPosition)) * 0.8;
gl_FragColor = vec4(mix(ink, uPaper, f), alpha * dens);
  gLine = vec4(vN * 0.5 + 0.5, alpha * 0.9);
}
`;

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function createDecals(scene) {
  const data = new Float32Array(MAX * STRIDE);
  const buffer = new THREE.InstancedInterleavedBuffer(data, STRIDE);
  buffer.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = quadGeometry();
  geometry.setAttribute('position', quad.attributes.position);
  geometry.setIndex(quad.index);
  geometry.setAttribute('aCenter', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
  geometry.setAttribute('aNormal', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
  geometry.setAttribute('aShape', new THREE.InterleavedBufferAttribute(buffer, 4, 6));
  geometry.setAttribute('aCol', new THREE.InterleavedBufferAttribute(buffer, 4, 10));
  geometry.setAttribute('aClip', new THREE.InterleavedBufferAttribute(buffer, 4, 14));
  geometry.instanceCount = 0;

  const base = { vertex: VERT, fragment: FRAG, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
  const material = inkMaterial({ ...base, blend: 'over' });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;
  scene.add(mesh);

  const inks = INKS.map((i) => hexToRgb(i.hex));
  let boxes = [];
  let cursor = 0, used = 0, time = 0;
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const clip = [0, 0, 0, 0];

  // Clip rectangle (in the decal's tangent frame, meters from pos) of the box face the point sits on.
  function faceClip(px, py, pz, nx, ny, nz) {
    clip[0] = clip[1] = -1e3; clip[2] = clip[3] = 1e3;
    const axis = Math.abs(nx) > 0.9 ? 0 : Math.abs(ny) > 0.9 ? 1 : Math.abs(nz) > 0.9 ? 2 : -1;
    if (axis < 0) return;
    const sgn = [nx, ny, nz][axis] > 0 ? 1 : -1;
    const p = [px, py, pz];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const plane = sgn > 0 ? b.max[axis] : b.min[axis];
      if (Math.abs(p[axis] - plane) > 0.08) continue;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      if (p[u] < b.min[u] - 0.05 || p[u] > b.max[u] + 0.05 || p[v] < b.min[v] - 0.05 || p[v] > b.max[v] + 0.05) continue;
      // tangent frame used by the shader: walls T = cross(Y, n), B = Y; floors/ceilings T = X, B = cross(n, X)
      let tAxis, tSign, bAxis, bSign;
      if (axis === 1) { tAxis = 0; tSign = 1; bAxis = 2; bSign = -sgn; }
      else if (axis === 0) { tAxis = 2; tSign = -sgn; bAxis = 1; bSign = 1; }
      else { tAxis = 0; tSign = sgn; bAxis = 1; bSign = 1; }
      const t0 = (b.min[tAxis] - p[tAxis]) * tSign, t1 = (b.max[tAxis] - p[tAxis]) * tSign;
      const b0 = (b.min[bAxis] - p[bAxis]) * bSign, b1 = (b.max[bAxis] - p[bAxis]) * bSign;
      clip[0] = Math.min(t0, t1); clip[2] = Math.max(t0, t1);
      clip[1] = Math.min(b0, b1); clip[3] = Math.max(b0, b1);
      return;
    }
  }

  function stamp(px, py, pz, nx, ny, nz, rgb, size, drip) {
    faceClip(px, py, pz, nx, ny, nz);
    const o = cursor * STRIDE;
    data[o] = px; data[o + 1] = py; data[o + 2] = pz;
    data[o + 3] = nx; data[o + 4] = ny; data[o + 5] = nz;
    data[o + 6] = size; data[o + 7] = rnd() * 6.283; data[o + 8] = rnd(); data[o + 9] = time;
    data[o + 10] = rgb[0]; data[o + 11] = rgb[1]; data[o + 12] = rgb[2];
    data[o + 13] = Math.abs(ny) < 0.5 ? drip : 0;
    data[o + 14] = clip[0]; data[o + 15] = clip[1]; data[o + 16] = clip[2]; data[o + 17] = clip[3];
    buffer.addUpdateRange(o, STRIDE);
    buffer.needsUpdate = true;
    cursor = (cursor + 1) % MAX;
    used = Math.min(MAX, used + 1);
    geometry.instanceCount = used;
    mesh.visible = true;
  }

  return {
    setMap(map) {
      boxes = map.boxes;
      seed = (map.seed >>> 0) || 1;
      this.clear();
    },
    clear() {
      cursor = 0; used = 0;
      geometry.instanceCount = 0;
      mesh.visible = false;
      buffer.clearUpdateRanges();
    },
    setTime(t) { time = t; },
    /** One splat. size = radius in meters, drip = 0..1 (walls only). */
    splat(pos, normal, colorIdx, size, drip = 0.5) {
      const n = normal || [0, 1, 0];
      stamp(pos[0], pos[1], pos[2], n[0], n[1], n[2], inks[(colorIdx | 0) % inks.length], size, drip);
    },
    /** Paint every surface within `radius` of a burst: a big splat at the closest point of each nearby face + satellites. */
    burst(pos, radius, colorIdx, budget = 14) {
      const rgb = inks[(colorIdx | 0) % inks.length];
      const hits = [];
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (pos[0] < b.min[0] - radius || pos[0] > b.max[0] + radius || pos[1] < b.min[1] - radius || pos[1] > b.max[1] + radius
          || pos[2] < b.min[2] - radius || pos[2] > b.max[2] + radius) continue;
        for (let f = 0; f < 6; f++) {
          const n = AXES[f], axis = f >> 1;
          const plane = n[axis] > 0 ? b.max[axis] : b.min[axis];
          const front = (pos[axis] - plane) * n[axis];
          if (front < -0.05 || front > radius) continue;
          const u = (axis + 1) % 3, v = (axis + 2) % 3;
          const cu = Math.min(b.max[u], Math.max(b.min[u], pos[u])), cv = Math.min(b.max[v], Math.max(b.min[v], pos[v]));
          const dist = Math.hypot(front, pos[u] - cu, pos[v] - cv);
          if (dist >= radius) continue;
          const c = [0, 0, 0];
          c[axis] = plane; c[u] = cu; c[v] = cv;
          hits.push({ c, n, dist, b, u, v });
        }
      }
      hits.sort((a, b) => a.dist - b.dist);
      let left = budget;
      for (const h of hits) {
        if (left <= 0) break;
        const k = 1 - h.dist / radius;
        stamp(h.c[0], h.c[1], h.c[2], h.n[0], h.n[1], h.n[2], rgb, radius * (0.22 + 0.34 * k), 0.4 + 0.5 * k);
        left--;
        const extra = Math.min(left, k > 0.5 ? 2 : 1);
        for (let e = 0; e < extra; e++) {
          const c = h.c.slice();
          const spread = radius * 0.6 * k;
          c[h.u] = Math.min(h.b.max[h.u], Math.max(h.b.min[h.u], c[h.u] + (rnd() - 0.5) * 2 * spread));
          c[h.v] = Math.min(h.b.max[h.v], Math.max(h.b.min[h.v], c[h.v] + (rnd() - 0.5) * 2 * spread));
          stamp(c[0], c[1], c[2], h.n[0], h.n[1], h.n[2], rgb, radius * (0.08 + 0.12 * rnd()), 0.3 + 0.4 * rnd());
          left--;
        }
      }
    },
    get count() { return used; },
    dispose() { geometry.dispose(); quad.dispose(); material.dispose(); scene.remove(mesh); },
  };
}
