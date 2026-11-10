// Transient effects: ink particles + paper confetti, tracers, rings/shockwaves and Blotter projectiles.
// Everything is pooled and GPU-animated from a birth time: no per-frame CPU work or allocation.
import * as THREE from 'three';
import { INKS } from '/shared/constants.js';
import { inkMaterial, hexToRgb, quadGeometry } from './common.js';

const N_PART = 1024, N_BEAM = 96, N_RING = 48, N_PROJ = 12;
const P_BLOB = 0, P_CONFETTI = 1, P_STAR = 2, P_CHAD = 3;
const RING = { dash: 0, rewind: 1, jumppad: 2, pickup: 3, spawn: 4, land: 5, shock: 6, flash: 7, hit: 8 };

function pool(count, layout) {
  const stride = layout.reduce((s, [, n]) => s + n, 0);
  const data = new Float32Array(count * stride);
  const buffer = new THREE.InstancedInterleavedBuffer(data, stride);
  buffer.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = quadGeometry();
  geometry.setAttribute('position', quad.attributes.position);
  geometry.setIndex(quad.index);
  let o = 0;
  for (const [name, n] of layout) { geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, n, o)); o += n; }
  geometry.instanceCount = count;
  let cursor = 0;
  return {
    geometry, data, stride,
    /** returns the float offset of a fresh slot (oldest recycled) */
    next() {
      const at = cursor * stride;
      cursor = (cursor + 1) % count;
      buffer.addUpdateRange(at, stride);
      buffer.needsUpdate = true;
      return at;
    },
    clear() { data.fill(0); buffer.clearUpdateRanges(); buffer.needsUpdate = true; cursor = 0; },
    dispose() { geometry.dispose(); quad.dispose(); },
  };
}

const PART_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aCol;     // rgb, type
attribute vec4 aLife;    // birth, life, size, seed
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
void main() {
  float age = uTime - aLife.x, t = age / max(aLife.y, 1e-3);
  if (aLife.y <= 0.0 || age < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float type = aCol.a;
  bool paper = type > 0.5 && type < 1.5;
  float k = paper ? 2.6 : 0.7, grav = paper ? 5.0 : 15.0;
  float e = (1.0 - exp(-k * age)) / k;
  vec3 p = aPos + aVel * e + vec3(0.0, -grav, 0.0) * (age - e) / k;
  float size = aLife.z;
  vec2 c = position.xy;
  if (type < 0.5) size *= 1.0 - t * t;
  else if (paper) {
    float ang = aLife.w * 6.283 + age * (5.0 + 9.0 * fract(aLife.w * 7.0));
    c.x *= cos(age * (8.0 + 6.0 * aLife.w) + aLife.w * 20.0);        // tumbling
    c = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (c * vec2(1.0, 0.6));
    p.x += sin(age * 5.0 + aLife.w * 30.0) * 0.12;
    size *= 1.0 - smoothstep(0.8, 1.0, t);
  } else {
    float ang = (aLife.w - 0.5) * 1.2;
    c = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * c;
    size *= sin(min(1.0, t * 5.0) * 1.5708) * (1.0 - smoothstep(0.7, 1.0, t)) * (1.0 + 0.25 * sin(age * 40.0));
  }
  vUv = position.xy; vCol = aCol; vSeed = aLife.w;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  mv.xy += c * size;
  gl_Position = projectionMatrix * mv;
  placeDepth();
}
`;
const PART_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying float vSeed;
void main() {
  float type = vCol.a, r = length(vUv);
  vec3 col = vCol.rgb;
  if (type < 0.5) {
    if (r > 1.0) discard;
    col *= r > 0.72 ? 0.84 : 1.0;
  } else if (type < 1.5) {
    col = vUv.x * vUv.y > 0.0 ? col : mix(col, vec3(1.0), 0.25);
  } else if (type < 2.5) {
    float a = atan(vUv.y, vUv.x);
    float star = 0.42 + 0.58 * pow(abs(cos(a * 2.5)), 2.6);
    if (r > star) discard;
    col = r < star * 0.5 ? mix(uPaper, vec3(1.0), 0.6) : col;
  } else {
    if (r > 1.0) discard;
    col = mix(uPaper, vec3(1.0), 0.3) * (r > 0.7 ? 0.86 : 1.0);
  }
  emitOver(col, 1.0, 1.0);
}
`;

const BEAM_VERT = /* glsl */`
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aCol;     // rgb, style
attribute vec4 aLife;    // birth, life, width, seed
varying vec2 vUv;        // x: meters along, y: -1..1 across
varying vec4 vCol;
varying vec4 vLife;
varying float vLen;
void main() {
  float age = uTime - aLife.x;
  if (aLife.y <= 0.0 || age < 0.0 || age >= aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 d = aTo - aFrom;
  float len = length(d), t = position.x * 0.5 + 0.5;
  vec3 p = aFrom + d * t;
  vec3 toCam = p - cameraPosition;
  vec3 side = normalize(cross(d, toCam) + 1e-5);
  float w = max(aLife.z, length(toCam) * 0.0019);     // never thinner than ~2 px
  p += side * position.y * w;
  vUv = vec2(t * len, position.y); vCol = aCol; vLife = aLife; vLen = len;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  placeDepth();
}
`;
const BEAM_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vLife;
varying float vLen;
void main() {
  float age = uTime - vLife.x, t = age / vLife.y, style = vCol.a, seed = vLife.w;
  vec3 col = vCol.rgb;
  float x = vUv.x, y = vUv.y;
  if (style < 0.5) {                     // stapler: one fast dash with a pale core
    float head = age * 260.0;
    if (x > head || x < head - 4.5) discard;
    col = abs(y) < 0.4 ? mix(uPaper, vec3(1.0), 0.6) : col;
  } else if (style < 1.5) {              // punch: thin pellet lines dissolving
    if (hash21(vec2(floor(x * 3.0), seed * 91.0)) < t * 1.15 || x > age * 500.0) discard;
  } else {                               // marker: hand-drawn stroke that dries out
    if (x > age * 700.0) discard;
    float edge = 0.62 + 0.38 * vnoise(vec2(x * 2.1 + seed * 40.0, 0.5));
    float wob = (vnoise(vec2(x * 0.9 + seed * 13.0, 3.0)) - 0.5) * 0.5;
    float yy = abs(y - wob);
    if (yy > edge) discard;
    float dry = smoothstep(0.3, 1.0, t);
    float n = vnoise(vec2(x * 4.0, y * 2.5 + seed * 9.0));
    if (n < dry * 1.2 - 0.12 + yy * dry * 0.6) discard;
    col *= yy > edge - 0.22 ? 0.84 : 1.0;
  }
  emitOver(col, 1.0, 1.0);
}
`;

const RING_VERT = /* glsl */`
attribute vec3 aPos;
attribute vec3 aAxis;    // ring plane normal; zero = face the camera
attribute vec4 aCol;     // rgb, kind
attribute vec4 aLife;    // birth, life, radius, seed
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vLife;
void main() {
  float age = uTime - aLife.x, t = age / max(aLife.y, 1e-3);
  if (aLife.y <= 0.0 || age < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vUv = position.xy; vCol = aCol; vLife = aLife;
  vec3 p = aPos;
  if (aCol.a > 1.5 && aCol.a < 2.5) p.y += t * 2.2;        // jump-pad rings rise
  if (dot(aAxis, aAxis) < 0.01) {
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * aLife.z;
    gl_Position = projectionMatrix * mv;
  } else {
    vec3 n = normalize(aAxis);
    vec3 T = normalize(abs(n.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : cross(vec3(0.0, 1.0, 0.0), n));
    vec3 B = cross(n, T);
    p += (T * position.x + B * position.y) * aLife.z + n * 0.03;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
  placeDepth();
}
`;
const RING_FRAG = /* glsl */`
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vLife;
float ringAt(float r, float R, float w) { return step(abs(r - R), w); }
void main() {
  float t = (uTime - vLife.x) / vLife.y, kind = vCol.a, seed = vLife.w;
  float r = length(vUv), a = atan(vUv.y, vUv.x);
  float front = 1.0 - (1.0 - t) * (1.0 - t);
  vec3 col = vCol.rgb;
  float m = 0.0;
  if (kind < 0.5) {            // dash: two thin rings
    m = max(ringAt(r, front * 0.95, 0.05 * (1.0 - t)), ringAt(r, front * 0.6, 0.035 * (1.0 - t)));
  } else if (kind < 1.5) {     // rewind: dashed ring closing inward, turning backwards
    float dash = step(0.45, fract(a * 1.9099 + t * 2.5));
    m = ringAt(r, 0.95 - front * 0.75, 0.06) * dash;
    m = max(m, ringAt(r, 0.6 - front * 0.5, 0.03));
  } else if (kind < 2.5) {     // jump pad: a fat rising hoop
    m = ringAt(r, 0.45 + front * 0.5, 0.11 * (1.0 - t));
  } else if (kind < 3.5) {     // pickup: ring + sparkle ticks
    m = ringAt(r, front * 0.7, 0.05 * (1.0 - t));
    m = max(m, step(abs(fract(a * 1.2732 + 0.5) - 0.5), 0.07) * step(abs(r - (0.5 + front * 0.42)), 0.12 * (1.0 - t)));
  } else if (kind < 4.5) {     // spawn: crop marks snapping outward + ring
    vec2 q = abs(vUv);
    float R = 0.35 + front * 0.6, w = 0.045;
    float corner = step(abs(max(q.x, q.y) - R), w) * step(R * 0.55, min(q.x, q.y));
    m = max(corner * (1.0 - t), ringAt(r, front * 0.5, 0.03 * (1.0 - t)));
  } else if (kind < 5.5) {     // land: dotted dust ring
    m = ringAt(r, 0.3 + front * 0.65, 0.07 * (1.0 - t)) * step(0.4, fract(a * 2.5465 + seed));
  } else if (kind < 6.5) {     // explosion shockwave: halftone disc, densest at the front
    float fr = 0.25 + front * 0.75;
    if (r > fr) discard;
    float cov = smoothstep(fr - 0.5, fr, r) * (1.0 - t * t) * 0.8;
    vec2 g = mat2(0.7071, 0.7071, -0.7071, 0.7071) * vUv * vLife.z / 0.34;
    m = max(step(length(fract(g) - 0.5), sqrt(clamp(cov, 0.0, 1.0) * 0.3)), ringAt(r, fr - 0.025, 0.025 * (1.0 - t)));
  } else if (kind < 7.5) {     // explosion core flash: paper-white, then ink
    float R = (0.45 + 0.55 * front) * (1.0 - smoothstep(0.5, 1.0, t)) * (0.72 + 0.28 * pow(abs(sin(a * 5.0 + seed * 20.0)), 0.6));
    m = step(r, R);
    col = t < 0.45 || r < R * 0.55 ? mix(uPaper, vec3(1.0), 0.7) : col;
  } else {                     // hit: short radial spokes
    m = step(abs(fract(a * 1.2732 + seed) - 0.5), 0.09) * step(abs(r - (0.35 + front * 0.5)), 0.2 * (1.0 - t));
  }
  if (m < 0.5) discard;
  emitOver(col, 1.0, 1.0);
}
`;

const PROJ_VERT = /* glsl */`
uniform float uPhase;
varying vec3 vN;
varying vec3 vW;
void main() {
  float wob = 0.16 * sin(uTime * 17.0 + position.y * 7.0 + uPhase) + 0.1 * sin(uTime * 23.0 + position.x * 9.0 + uPhase * 2.0);
  vec4 wp = modelMatrix * vec4(position * (1.0 + wob), 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  placeDepth();
}
`;
const PROJ_FRAG = /* glsl */`
uniform vec3 uTint;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float spec = step(0.9, dot(n, normalize(v + uSunDir)));
  float shade = step(dot(n, uSunDir), -0.15);
  emit(mix(uTint * (1.0 - 0.2 * shade), vec3(1.0), spec), 0.0, 0.0, n);
}
`;

export function createFx({ scene, decals, post }) {
  const inks = INKS.map((i) => hexToRgb(i.hex));
  const ink = (idx) => inks[(idx | 0) % inks.length];
  const PAPER_SCRAP = [0.97, 0.95, 0.9];
  let time = 0;
  let camera = null;
  const rnd = Math.random;

  const parts = pool(N_PART, [['aPos', 3], ['aVel', 3], ['aCol', 4], ['aLife', 4]]);
  const beams = pool(N_BEAM, [['aFrom', 3], ['aTo', 3], ['aCol', 4], ['aLife', 4]]);
  const rings = pool(N_RING, [['aPos', 3], ['aAxis', 3], ['aCol', 4], ['aLife', 4]]);
  const mk = (p, vertex, fragment, order) => {
    const mesh = new THREE.Mesh(p.geometry, inkMaterial({ vertex, fragment, blend: 'over', side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    scene.add(mesh);
    return mesh;
  };
  const partMesh = mk(parts, PART_VERT, PART_FRAG, 22);
  const beamMesh = mk(beams, BEAM_VERT, BEAM_FRAG, 21);
  const ringMesh = mk(rings, RING_VERT, RING_FRAG, 20);

  function particle(x, y, z, vx, vy, vz, rgb, type, size, life) {
    const d = parts.data, o = parts.next();
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = rgb[0]; d[o + 7] = rgb[1]; d[o + 8] = rgb[2]; d[o + 9] = type;
    d[o + 10] = time; d[o + 11] = life; d[o + 12] = size; d[o + 13] = rnd();
  }
  function ring(pos, axis, rgb, kind, radius, life, delay = 0) {
    const d = rings.data, o = rings.next();
    d[o] = pos[0]; d[o + 1] = pos[1]; d[o + 2] = pos[2];
    d[o + 3] = axis ? axis[0] : 0; d[o + 4] = axis ? axis[1] : 0; d[o + 5] = axis ? axis[2] : 0;
    d[o + 6] = rgb[0]; d[o + 7] = rgb[1]; d[o + 8] = rgb[2]; d[o + 9] = kind;
    d[o + 10] = time + delay; d[o + 11] = life; d[o + 12] = radius; d[o + 13] = rnd();
  }
  // spray n blobs in a cone around direction (dx,dy,dz); spread 1 = hemisphere, 2 = full sphere
  function spray(pos, dx, dy, dz, n, rgb, speed, spread, size, life, type = P_BLOB) {
    for (let i = 0; i < n; i++) {
      let rx = rnd() * 2 - 1, ry = rnd() * 2 - 1, rz = rnd() * 2 - 1;
      const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
      const vx = dx + rx * spread, vy = dy + ry * spread, vz = dz + rz * spread;
      const s = speed * (0.35 + 0.65 * rnd());
      particle(pos[0], pos[1], pos[2], vx * s, vy * s, vz * s, rgb, type, size * (0.5 + rnd()), life * (0.6 + 0.4 * rnd()));
    }
  }
  const UP = [0, 1, 0];
  const camDist = (pos) => (camera ? Math.hypot(pos[0] - camera.position.x, pos[1] - camera.position.y, pos[2] - camera.position.z) : 1e3);
  const _v = new THREE.Vector3();

  // --- projectiles: a few wobbling opaque ink blobs (they get composite outlines for free) ---
  const projGeo = new THREE.IcosahedronGeometry(1, 2);
  const projs = new Map();
  const freeProjs = [];
  function makeProj() {
    const uniforms = { uTint: { value: new THREE.Vector3() }, uPhase: { value: rnd() * 6 } };
    const mesh = new THREE.Mesh(projGeo, inkMaterial({ vertex: PROJ_VERT, fragment: PROJ_FRAG, uniforms }));
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, uniforms, rgb: PAPER_SCRAP, last: [0, 0, 0], fresh: true };
  }

  const api = {
    tracer(from, to, colorIdx, weaponId) {
      const w = weaponId | 0;
      if (w === 3) return;
      const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      if (len < 0.05) return;
      const rgb = ink(colorIdx);
      const d = beams.data, o = beams.next();
      d[o] = from[0]; d[o + 1] = from[1]; d[o + 2] = from[2]; d[o + 3] = to[0]; d[o + 4] = to[1]; d[o + 5] = to[2];
      d[o + 6] = rgb[0]; d[o + 7] = rgb[1]; d[o + 8] = rgb[2]; d[o + 9] = w;
      d[o + 10] = time;
      d[o + 11] = w === 0 ? len / 260 + 0.03 : w === 1 ? 0.16 : 1.5;
      d[o + 12] = w === 0 ? 0.022 : w === 1 ? 0.012 : 0.075;
      d[o + 13] = rnd();
    },
    impact(pos, normal, colorIdx, weaponId) {
      const w = weaponId | 0, n = normal || UP, rgb = ink(colorIdx);
      const size = w === 0 ? 0.2 + rnd() * 0.12 : w === 1 ? 0.12 + rnd() * 0.1 : w === 2 ? 0.42 + rnd() * 0.15 : 0.5;
      decals.splat(pos, n, colorIdx, size, w === 2 ? 0.9 : 0.25 + rnd() * 0.5);
      spray(pos, n[0] * 1.2, n[1] * 1.2 + 0.4, n[2] * 1.2, w === 1 ? 2 : w === 2 ? 7 : 3, rgb, w === 2 ? 5 : 3.5, 0.7, 0.045, 0.45);
      if (w === 1) particle(pos[0], pos[1], pos[2], n[0] * 2 + rnd() - 0.5, n[1] * 2 + 1.5, n[2] * 2 + rnd() - 0.5, PAPER_SCRAP, P_CHAD, 0.035, 0.7);
    },
    hitPlayer(pos, colorIdx, headshot) {
      const rgb = ink(colorIdx);
      spray(pos, 0, 0.5, 0, headshot ? 14 : 8, rgb, headshot ? 6 : 4.5, 1.0, headshot ? 0.075 : 0.06, 0.5);
      ring(pos, null, rgb, RING.hit, headshot ? 0.7 : 0.42, 0.18);
      if (headshot) {
        particle(pos[0], pos[1] + 0.25, pos[2], 0, 1.2, 0, rgb, P_STAR, 0.42, 0.5);
        spray(pos, 0, 1, 0, 4, PAPER_SCRAP, 4, 0.8, 0.05, 0.7, P_CONFETTI);
      }
    },
    explosion(pos, radius, colorIdx) {
      const rgb = ink(colorIdx), r = radius || 4;
      ring(pos, null, rgb, RING.flash, r * 0.42, 0.17);
      ring(pos, null, rgb, RING.shock, r, 0.42);
      ring([pos[0], pos[1] - 0.2, pos[2]], UP, rgb, RING.dash, r * 1.1, 0.45);
      spray(pos, 0, 0.6, 0, 30, rgb, r * 3.2, 1.0, 0.13, 0.8);
      spray(pos, 0, 0.8, 0, 8, PAPER_SCRAP, r * 2, 1.0, 0.05, 0.9, P_CHAD);
      decals.burst(pos, r * 0.85, colorIdx, 14);
      const dist = camDist(pos);
      const near = Math.max(0, 1 - dist / (r * 4));
      if (near > 0) { api.shake(0.75 * near); post.kick(0.9 * near); }
    },
    death(pos, colorIdx, victimColorIdx) {
      const rgb = ink(colorIdx), vic = ink(victimColorIdx ?? colorIdx);
      const c = [pos[0], pos[1] + 0.9, pos[2]];
      decals.burst(c, 2.8, colorIdx, 10);
      spray(c, 0, 0.9, 0, 22, rgb, 7, 1.0, 0.12, 0.8);
      spray(c, 0, 1.3, 0, 34, vic, 6.5, 1.0, 0.085, 1.5, P_CONFETTI);
      spray(c, 0, 1.3, 0, 12, PAPER_SCRAP, 6, 1.0, 0.07, 1.4, P_CONFETTI);
      particle(c[0], c[1] + 0.5, c[2], 0, 1.5, 0, vic, P_STAR, 0.8, 0.55);
      ring(c, null, rgb, RING.flash, 1.3, 0.24);
      ring([pos[0], pos[1] + 0.05, pos[2]], UP, vic, RING.spawn, 1.6, 0.5);
      // comic impact frame, only when it happens in front of the viewer and reasonably close
      const dist = camDist(c);
      if (camera && dist < 30) {
        _v.set(c[0], c[1], c[2]).project(camera);
        if (_v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1) {
          post.burst(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, Math.min(0.55, 2.4 / Math.max(2.5, dist) + 0.07), vic);
        }
        api.shake(0.35 * (1 - dist / 30));
      }
    },
    ring(pos, colorIdx, kind) {
      const rgb = ink(colorIdx);
      const k = RING[kind] ?? RING.dash;
      if (k === RING.dash) ring([pos[0], pos[1] + 0.9, pos[2]], null, rgb, k, 1.1, 0.3);
      else if (k === RING.rewind) { ring([pos[0], pos[1] + 0.9, pos[2]], null, rgb, k, 1.5, 0.55); ring([pos[0], pos[1] + 0.05, pos[2]], UP, rgb, k, 1.3, 0.55); }
      else if (k === RING.jumppad) {
        // staggered hoops: birth times in the future, the shader waits for them
        for (let i = 0; i < 3; i++) ring([pos[0], pos[1] + 0.15, pos[2]], UP, rgb, k, 1.25, 0.5, i * 0.09);
        spray(pos, 0, 2.2, 0, 6, rgb, 5, 0.35, 0.06, 0.5);
      }
      else if (k === RING.pickup) { ring(pos, null, rgb, k, 1.0, 0.45); spray(pos, 0, 1, 0, 8, rgb, 3.5, 1.0, 0.05, 0.5); }
      else if (k === RING.spawn) { ring([pos[0], pos[1] + 0.05, pos[2]], UP, rgb, k, 1.5, 0.6); ring([pos[0], pos[1] + 1, pos[2]], null, rgb, RING.dash, 1.4, 0.4); }
      else ring([pos[0], pos[1] + 0.04, pos[2]], UP, rgb, k, 0.9, 0.32);
    },
    shake() {},   // installed by index.js (camera shake lives with the camera)
    flash(kind) { post.flash(kind); },
  };
  return {
    api,
    projectile: {
      spawn(pid, colorIdx) {
        let p = projs.get(pid);
        if (!p) {
          if (projs.size >= N_PROJ) return;
          p = freeProjs.pop() || makeProj();
          projs.set(pid, p);
        }
        p.rgb = ink(colorIdx);
        p.uniforms.uTint.value.set(p.rgb[0], p.rgb[1], p.rgb[2]);
        p.fresh = true;
        p.mesh.visible = false;
      },
      move(pid, pos) {
        const p = projs.get(pid);
        if (!p) return;
        p.mesh.position.set(pos[0], pos[1], pos[2]);
        p.mesh.scale.setScalar(0.24);
        p.mesh.visible = true;
        const dx = pos[0] - p.last[0], dy = pos[1] - p.last[1], dz = pos[2] - p.last[2];
        if (p.fresh || dx * dx + dy * dy + dz * dz > 0.09) {
          if (!p.fresh) particle(pos[0], pos[1], pos[2], (rnd() - 0.5) * 0.6, 0.4, (rnd() - 0.5) * 0.6, p.rgb, P_BLOB, 0.1 + rnd() * 0.06, 0.4);
          p.last[0] = pos[0]; p.last[1] = pos[1]; p.last[2] = pos[2];
          p.fresh = false;
        }
      },
      remove(pid) {
        const p = projs.get(pid);
        if (!p) return;
        p.mesh.visible = false;
        projs.delete(pid);
        freeProjs.push(p);
      },
    },
    update(t, cam) { time = t; camera = cam; },
    clear() {
      parts.clear(); beams.clear(); rings.clear();
      for (const [pid, p] of projs) { p.mesh.visible = false; freeProjs.push(p); projs.delete(pid); }
    },
    dispose() {
      for (const m of [partMesh, beamMesh, ringMesh]) { scene.remove(m); m.material.dispose(); }
      parts.dispose(); beams.dispose(); rings.dispose(); projGeo.dispose();
      for (const p of [...projs.values(), ...freeProjs]) { scene.remove(p.mesh); p.mesh.material.dispose(); }
    },
  };
}
