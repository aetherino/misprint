// Pickups: health = a spinning correction-fluid bottle with a cross sticker, overprint = a big rotating
// registration target with a halftone glow. Inactive pickups stay as a faint watermark (respawn hint).
import * as THREE from 'three';
import { inkMaterial, quadGeometry } from './common.js';
import { RigBuilder, PAL, setPart } from './geo.js';
import { makeRigUniforms, rigMaterial } from './rig.js';

const TINT = { health: [1.0, 0.29, 0.2], overprint: [1.0, 0.82, 0.12] };

function healthGeometry() {
  const b = new RigBuilder();
  b.cyl(0.17, 0.19, 0.36, { p: [0, 0, 0], pal: PAL.PAPER, seg: 12 });
  b.cyl(0.09, 0.17, 0.08, { p: [0, 0.22, 0], pal: PAL.PAPER, seg: 12 });
  b.cyl(0.1, 0.11, 0.2, { p: [0, 0.36, 0], pal: PAL.INK, seg: 10 });
  b.cyl(0.195, 0.195, 0.05, { p: [0, -0.15, 0], pal: PAL.DARK, seg: 12 });
  for (const z of [-1, 1]) {
    b.box(0.2, 0.065, 0.02, { p: [0, 0.02, z * 0.175], pal: PAL.INK });
    b.box(0.065, 0.2, 0.02, { p: [0, 0.02, z * 0.175], pal: PAL.INK });
  }
  return b.build();
}
function overprintGeometry() {
  const b = new RigBuilder();
  b.torus(0.46, 0.05, { pal: PAL.INK });
  b.torus(0.24, 0.04, { pal: PAL.DARK });
  b.box(1.3, 0.07, 0.07, { pal: PAL.DARK });
  b.box(0.07, 1.3, 0.07, { pal: PAL.DARK });
  b.ball(0.1, { pal: PAL.INK, seg: 10 });
  return b.build();
}

const HALO_VERT = /* glsl */`
uniform float uRadius;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uRadius;
  gl_Position = projectionMatrix * mv;
  placeDepth();
}
`;
const HALO_FRAG = /* glsl */`
uniform vec3 uTint;
uniform float uRadius;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float pulse = 0.5 + 0.5 * sin(uTime * 3.0 - r * 5.0);
  float cov = (1.0 - r) * (0.55 + 0.35 * pulse);
  vec2 g = mat2(0.7071, 0.7071, -0.7071, 0.7071) * vUv * uRadius / 0.11;
  if (length(fract(g) - 0.5) > sqrt(cov * 0.36)) discard;
  emitOver(uTint, 1.0, 0.6);
}
`;

export function createPickups(scene) {
  const geos = { health: healthGeometry(), overprint: overprintGeometry() };
  const haloGeo = quadGeometry();
  const items = new Map();

  function make(type) {
    const uniforms = makeRigUniforms(1, { dotScale: 1 });
    const tint = TINT[type] || TINT.health;
    uniforms.uTint.value.set(tint[0], tint[1], tint[2]);
    uniforms.uGhost.value = 0.2;
    const geo = geos[type] || geos.health;
    const root = new THREE.Group();
    const body = new THREE.Mesh(geo, rigMaterial('body', 1, uniforms));
    const hull = new THREE.Mesh(geo, rigMaterial('hull', 1, uniforms));
    const ghost = new THREE.Mesh(geo, rigMaterial('ghost', 1, uniforms));
    const radius = type === 'overprint' ? 1.25 : 0.62;
    const halo = new THREE.Mesh(haloGeo, inkMaterial({
      vertex: HALO_VERT, fragment: HALO_FRAG, blend: 'over',
      uniforms: { uTint: uniforms.uTint, uRadius: { value: radius } },
    }));
    halo.renderOrder = 3;
    for (const m of [body, hull, ghost, halo]) { m.frustumCulled = false; root.add(m); }
    scene.add(root);
    return { type, root, body, hull, ghost, halo, uniforms, active: true, pop: 1, phase: Math.random() * 6 };
  }
  function drop(it) {
    scene.remove(it.root);
    for (const m of [it.body, it.hull, it.ghost, it.halo]) m.material.dispose();
  }

  return {
    set(list) {
      const seen = new Set();
      for (const p of list || []) {
        seen.add(p.id);
        let it = items.get(p.id);
        if (it && it.type !== p.type) { drop(it); it = null; }
        if (!it) { it = make(p.type); items.set(p.id, it); it.active = p.active !== false; }
        it.root.position.set(p.pos[0], p.pos[1], p.pos[2]);
        const active = p.active !== false;
        if (active && !it.active) it.pop = 0;      // respawned: print it back in
        it.active = active;
      }
      for (const [id, it] of items) if (!seen.has(id)) { drop(it); items.delete(id); }
    },
    update(dt, time) {
      for (const it of items.values()) {
        it.pop = Math.min(1, it.pop + dt / 0.5);
        const big = it.type === 'overprint';
        const bob = Math.sin(time * 2 + it.phase) * 0.08;
        const s = big ? 1.05 : 1.15;
        setPart(it.uniforms.uPart.value, 0, 0, bob, 0, big ? 0 : 0.25, time * (big ? 1.1 : 1.8) + it.phase, big ? 0 : 0.2, s);
        it.uniforms.uPrint.value.set(-0.8 * s + it.pop * 1.7 * s + bob, it.pop < 1 ? 1 : 0);
        it.body.visible = it.hull.visible = it.halo.visible = it.active;
        it.ghost.visible = !it.active;
      }
    },
    clear() { for (const it of items.values()) drop(it); items.clear(); },
    dispose() { this.clear(); geos.health.dispose(); geos.overprint.dispose(); haloGeo.dispose(); },
  };
}
