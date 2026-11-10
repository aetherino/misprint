// First-person viewmodel: mitten hands + the four office-supply weapons, one palette-skinned draw.
// Lives in its own scene/camera (FOV 60) but is rendered into the same plates as the world using the
// near slice of the depth range, so it gets the same ink outlines and misregistration and never clips walls.
import * as THREE from 'three';
import { INKS } from '/shared/constants.js';
import { inkMaterial, setHex, quadGeometry } from './common.js';
import { RigBuilder, setPart, setChildPart, hidePart } from './geo.js';
import { makeRigUniforms, rigMaterial } from './rig.js';
import { addWeapon, addHand, MUZZLE, MOVER } from './models.js';

const HAND_R = 0, HAND_L = 1, NPARTS = 10;
const bodyPart = (w) => 2 + w * 2, moverPart = (w) => 3 + w * 2;

// rest pose per weapon: grip position, yaw-in, scale, kick strength, where the hands sit (weapon space)
const POSE = [
  { p: [0.15, -0.135, -0.4], ry: 0.2, s: 0.62, kick: 0.55, left: null },
  { p: [0.15, -0.15, -0.4], ry: 0.18, s: 0.6, kick: 1.5, left: null },
  { p: [0.15, -0.13, -0.36], ry: 0.2, s: 0.62, kick: 1.1, left: [-0.01, -0.065, -0.2] },
  { p: [0.15, -0.14, -0.38], ry: 0.2, s: 0.62, kick: 1.2, left: [-0.01, -0.07, -0.2] },
];

const BURST_VERT = /* glsl */`
uniform vec4 uBurst;   // view xyz, size
uniform float uSpin;
varying vec2 vUv;
void main() {
  vUv = position.xy;
  float c = cos(uSpin), s = sin(uSpin);
  vec3 p = uBurst.xyz + vec3(mat2(c, s, -s, c) * position.xy, 0.0) * uBurst.w;
  gl_Position = projectionMatrix * vec4(p, 1.0);
  placeDepth();
}
`;
const BURST_FRAG = /* glsl */`
uniform vec3 uTint;
uniform float uLife;   // 1 -> 0
varying vec2 vUv;
void main() {
  float a = atan(vUv.y, vUv.x), r = length(vUv);
  float star = 0.42 + 0.5 * pow(abs(sin(a * 4.0)), 3.0) + 0.12 * sin(a * 13.0);
  if (r > star * (1.3 - 0.6 * uLife)) discard;
  vec3 col = r < star * 0.42 ? mix(uPaper, vec3(1.0), 0.5) : uTint;
  emitOver(col, 1.0, 1.0);
}
`;

const seg = (u, a, b) => { const t = Math.min(1, Math.max(0, (u - a) / (b - a))); return t * t * (3 - 2 * t); };
const pulse = (u, a, b, c, d) => seg(u, a, b) * (1 - seg(u, c, d));     // 0 → 1 (a..b), hold, → 0 (c..d)

export function createViewmodel() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.03, 8);
  const b = new RigBuilder();
  addHand(b, HAND_R, 1);
  addHand(b, HAND_L, -1);
  for (let w = 0; w < 4; w++) addWeapon(b, w, bodyPart(w), moverPart(w));
  const geometry = b.build();
  const uniforms = makeRigUniforms(NPARTS, { viewmodel: true, dotScale: 4.5 });
  const mesh = new THREE.Mesh(geometry, rigMaterial('body', NPARTS, uniforms, true));
  mesh.frustumCulled = false;
  scene.add(mesh);

  const burstUniforms = { uBurst: { value: new THREE.Vector4(0, 0, -1, 0.1) }, uSpin: { value: 0 }, uLife: { value: 0 }, uTint: uniforms.uTint };
  const burstGeo = quadGeometry();
  const burst = new THREE.Mesh(burstGeo, inkMaterial({ vertex: BURST_VERT, fragment: BURST_FRAG, uniforms: burstUniforms, viewmodel: true, blend: 'over', depthTest: false }));
  burst.frustumCulled = false;
  burst.visible = false;
  burst.renderOrder = 10;
  scene.add(burst);

  const A = uniforms.uPart.value;
  const st = {
    weapon: 0, shown: 0, swap: 1, visible: true, alive: true,
    kick: 0, snap: 0, roll: 0, charge: 0, bead: 0,
    reloadT: -1, reloadDur: 1, reloadW: 0,
    swayX: 0, swayY: 0, bobPhase: 0, bobAmt: 0, tilt: 0, lower: 0, dip: 0, dipVel: 0, push: 0,
    wasGround: true, lastVy: 0, burstLife: 0,
  };
  const feel = { speed: 0, onGround: true, sliding: false, dashing: false, wallSide: 0, look: [0, 0], vy: 0 };
  const _muzzleView = new THREE.Vector3(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _f = new THREE.Vector3();

  function muzzleView(out) {
    const m = MUZZLE[st.shown];
    return out.set(m[0], m[1], m[2]).applyMatrix4(_m.fromArray(A, bodyPart(st.shown) * 16));
  }

  // Reload choreography: each returns offsets for the weapon + the mover angle/offset + the left hand.
  function reloadPose(w, u, o) {
    if (w === 0) {            // stapler: tip up, flip the arm open, thumb a strip of staples in, slap shut
      const up = pulse(u, 0.0, 0.18, 0.78, 1.0);
      o.rx += 0.3 * up; o.rz += 0.38 * up; o.y += 0.01 * up; o.x += 0.03 * up;   // stays clear of the crosshair
      o.mover = 1.25 * pulse(u, 0.12, 0.3, 0.68, 0.76);
      o.hand = pulse(u, 0.28, 0.46, 0.6, 0.72);
      o.handPos = [0.0, 0.1 + 0.1 * (1 - seg(u, 0.4, 0.56)), -0.15];
      o.kick += 0.5 * pulse(u, 0.74, 0.77, 0.78, 0.9);
    } else if (w === 1) {     // hole punch: roll over to dump the chads, then pump the lever twice
      const dump = pulse(u, 0.04, 0.2, 0.42, 0.56);
      o.rz += 1.25 * dump; o.y -= 0.05 * dump; o.x -= 0.01 * dump;
      o.y += 0.012 * dump * Math.sin(u * 90);
      const pump = Math.max(pulse(u, 0.56, 0.64, 0.66, 0.74), pulse(u, 0.76, 0.84, 0.86, 0.95));
      o.mover = 0.3 * pump;
      o.rx -= 0.1 * pump; o.y -= 0.02 * pump;
      o.hand = pulse(u, 0.5, 0.6, 0.9, 0.98);
      o.handPos = [0, 0.13 - 0.07 * pump, 0.22];
    } else if (w === 2) {     // marker: pen twirl, then a shake to wet the tip
      const lift = pulse(u, 0.0, 0.15, 0.8, 1.0);
      o.x -= 0.02 * lift; o.y += 0.02 * lift; o.z -= 0.04 * lift;
      o.rz += Math.PI * 2 * seg(u, 0.1, 0.62);
      o.rx += 0.22 * lift;
      const shake = pulse(u, 0.64, 0.68, 0.84, 0.9);
      o.y += 0.03 * shake * Math.sin(u * 70);
      o.release = lift;
      o.bead = seg(u, 0.7, 0.95) * 0.35;
    } else {                  // blotter: pop the empty bottle, slam a fresh one down
      const tip = pulse(u, 0.0, 0.14, 0.82, 1.0);
      o.rz += 0.35 * tip; o.rx += 0.25 * tip; o.x -= 0.04 * tip;
      const out = seg(u, 0.1, 0.32), back = seg(u, 0.5, 0.8);
      o.moverPos = u < 0.42 ? [0.12 * out, 0.22 * out - 0.25 * out * out, 0.1 * out] : [-0.1 * (1 - back), 0.3 * (1 - back), 0];
      o.moverScale = u < 0.42 ? 1 - seg(u, 0.3, 0.42) : seg(u, 0.44, 0.52);
      o.moverRot = u < 0.42 ? 2.2 * out : 0;
      o.hand = pulse(u, 0.4, 0.52, 0.84, 0.94);
      o.handPos = [o.moverPos[0], o.moverPos[1] + 0.2, -0.1 + o.moverPos[2]];
      o.kick += 0.7 * pulse(u, 0.8, 0.82, 0.83, 0.94);
      o.release = pulse(u, 0.3, 0.45, 0.85, 0.95);
    }
  }
  const off = {};

  function update(dt) {
    const visible = st.visible && st.alive;
    mesh.visible = visible;
    if (!visible) { burst.visible = false; return; }

    // swap: lower the old weapon, raise the new one
    if (st.swap < 1) {
      st.swap = Math.min(1, st.swap + dt / 0.3);
      if (st.swap >= 0.4 && st.shown !== st.weapon) { st.shown = st.weapon; st.reloadT = -1; st.kick = 0; }
    }
    const w = st.shown, P = POSE[w];
    const swapDown = st.shown !== st.weapon ? seg(st.swap, 0, 0.4) : 1 - seg(st.swap, 0.4, 1);

    // feel: sway lags the look, bob follows the stride, tilt into wall-runs, dip on landings
    st.swayX += (-feel.look[0] * 1.6 - st.swayX) * Math.min(1, dt * 9);
    st.swayY += (feel.look[1] * 1.6 - st.swayY) * Math.min(1, dt * 9);
    st.swayX = Math.max(-0.12, Math.min(0.12, st.swayX)); st.swayY = Math.max(-0.1, Math.min(0.1, st.swayY));
    const moving = feel.onGround && !feel.sliding ? Math.min(1, feel.speed / 8) : 0;
    st.bobAmt += (moving - st.bobAmt) * Math.min(1, dt * 8);
    st.bobPhase += feel.speed * dt * 1.25 * (feel.onGround ? 1 : 0);
    st.tilt += (feel.wallSide * -0.28 + (feel.sliding ? 0.42 : 0) - st.tilt) * Math.min(1, dt * 8);
    st.lower += ((feel.sliding ? 1 : 0) - st.lower) * Math.min(1, dt * 9);
    st.push += ((feel.dashing ? 1 : 0) - st.push) * Math.min(1, dt * 16);
    if (feel.onGround && !st.wasGround) st.dipVel -= Math.min(1.6, Math.abs(st.lastVy) * 0.09);
    st.wasGround = feel.onGround; st.lastVy = feel.vy;
    // explicit spring: sub-step so a long frame cannot blow it up
    for (let left = Math.min(dt, 0.25); left > 1e-6; left -= 1 / 60) {
      const h = Math.min(left, 1 / 60);
      st.dipVel += (-st.dip * 140 - st.dipVel * 15) * h;
      st.dip += st.dipVel * h;
    }
    const airY = feel.onGround ? 0 : Math.max(-0.03, Math.min(0.03, -feel.vy * 0.003));

    st.kick = Math.max(0, st.kick - dt * (5 + st.kick * 14));
    st.snap = Math.max(0, st.snap - dt * (w === 1 ? 5 : 16));
    st.roll *= Math.max(0, 1 - dt * 10);

    off.x = 0; off.y = 0; off.z = 0; off.rx = 0; off.rz = 0; off.kick = 0;
    off.mover = 0; off.hand = 0; off.handPos = null; off.release = 0; off.bead = -1;
    off.moverPos = null; off.moverScale = 1; off.moverRot = 0;
    if (st.reloadT >= 0) {
      st.reloadT += dt;
      const u = st.reloadT / st.reloadDur;
      if (u >= 1) st.reloadT = -1; else reloadPose(w, u, off);
    }

    const k = (st.kick + off.kick) * P.kick;
    const tremble = st.charge > 0 ? st.charge * 0.004 : 0;
    const px = P.p[0] + st.swayX * 0.5 + Math.sin(st.bobPhase) * 0.012 * st.bobAmt + off.x + (Math.random() - 0.5) * tremble;
    const py = P.p[1] + st.swayY * 0.5 - Math.abs(Math.cos(st.bobPhase)) * 0.012 * st.bobAmt + airY + st.dip * 0.06
      - 0.05 * st.lower - 0.3 * swapDown + off.y + k * 0.012 + (Math.random() - 0.5) * tremble;
    const pz = P.p[2] + k * 0.05 - 0.05 * st.push + off.z - 0.03 * st.charge;
    const rx = k * 0.16 + st.swayY * 0.9 - 0.7 * swapDown + off.rx + st.dip * 0.2;
    const ry = P.ry + st.swayX * 1.1;
    const rz = st.tilt + st.swayX * -1.4 + st.roll * k + off.rz;
    setPart(A, bodyPart(w), px, py, pz, rx, ry, rz, P.s);

    // the moving piece of each weapon
    const M = MOVER[w];
    let ang = M.rest;
    let mx = M.pivot[0], my = M.pivot[1], mz = M.pivot[2], ms = 1;
    if (w === 0) ang = M.rest * (1 - st.snap) + off.mover;
    else if (w === 1) ang = M.rest * (1 - st.snap) + off.mover;
    else if (w === 2) {
      st.bead += ((off.bead >= 0 ? off.bead : 0.3 + st.charge * 1.5) - st.bead) * Math.min(1, dt * 18);
      ms = st.bead; my -= 0.012 * st.bead;
    } else {
      my += 0.03 * st.snap;
      if (off.moverPos) { mx += off.moverPos[0]; my += off.moverPos[1]; mz += off.moverPos[2]; }
      ms = off.moverScale; ang = off.moverRot;
    }
    setChildPart(A, moverPart(w), bodyPart(w), mx, my, mz, ang, 0, w === 3 ? ang * 0.6 : 0, ms);
    for (let i = 0; i < 4; i++) if (i !== w) { hidePart(A, bodyPart(i)); hidePart(A, moverPart(i)); }

    // hands: right on the grip, left under the barrel or doing the reload business
    const rel = off.release;
    setChildPart(A, HAND_R, bodyPart(w), 0.012, -0.095, 0.05, 0.3, 0, 0, 1.15);
    if (off.hand > 0.01 && off.handPos) {
      setChildPart(A, HAND_L, bodyPart(w), off.handPos[0] - 0.25 * (1 - off.hand), off.handPos[1] - 0.25 * (1 - off.hand), off.handPos[2], 0.2, 0.6, 0.4, 1.15);
    } else if (P.left && rel < 0.99) {
      setChildPart(A, HAND_L, bodyPart(w), P.left[0] - 0.2 * rel, P.left[1] - 0.25 * rel, P.left[2], 0.15, 0.5, 0.5, 1.15);
    } else hidePart(A, HAND_L);

    uniforms.uCharge.value = w === 2 ? Math.max(st.charge, 0.15 * st.bead) : (w === 3 ? 0.25 : 0);

    // muzzle burst
    if (st.burstLife > 0) {
      st.burstLife = Math.max(0, st.burstLife - dt / 0.07);
      muzzleView(_muzzleView);
      burstUniforms.uBurst.value.set(_muzzleView.x, _muzzleView.y, _muzzleView.z - 0.02, burstUniforms.uBurst.value.w);
      burstUniforms.uLife.value = st.burstLife;
    }
    burst.visible = st.burstLife > 0;
  }

  return {
    scene, camera,
    api: {
      setWeapon(id) {
        id = (id | 0) & 3;
        if (id === st.weapon) return;
        st.weapon = id;
        st.swap = st.shown === id ? Math.max(st.swap, 0.4) : 0;
      },
      fire(weaponId, charge = 1) {
        const w = (weaponId | 0) & 3;
        if (w !== st.shown) { st.weapon = st.shown = w; st.swap = 1; }
        const power = w === 2 ? 0.45 + 0.75 * charge : 1;
        st.kick = Math.min(1.6, st.kick * 0.4 + power);
        st.snap = 1;
        st.roll = (Math.random() - 0.5) * 0.5;
        st.charge = 0;
        if (w === 2) st.bead = 0;
        st.burstLife = 1;
        burstUniforms.uSpin.value = Math.random() * 6.28;
        burstUniforms.uBurst.value.w = [0.045, 0.09, 0.06 + 0.05 * charge, 0.08][w];
      },
      reload(weaponId, seconds) {
        const w = (weaponId | 0) & 3;
        if (w !== st.shown) { st.weapon = st.shown = w; st.swap = 1; }
        st.reloadT = 0; st.reloadDur = Math.max(0.05, seconds || 1); st.reloadW = w;
      },
      setCharge(c) { st.charge = Math.min(1, Math.max(0, c || 0)); },
      setInk(colorIdx) { setHex(uniforms.uTint.value, INKS[(colorIdx | 0) % INKS.length].hex); },
      setVisible(v) { st.visible = !!v; },
    },
    setFeel(state) {
      feel.speed = state.speed || 0;
      feel.onGround = state.onGround !== false;
      feel.sliding = !!state.sliding;
      feel.dashing = !!state.dashing;
      feel.wallSide = state.wallSide || 0;
      feel.look[0] = state.lookDelta ? state.lookDelta[0] : 0;
      feel.look[1] = state.lookDelta ? state.lookDelta[1] : 0;
      feel.vy = state.vel ? state.vel[1] : 0;
      st.alive = state.alive !== false;
    },
    update,
    setAspect(aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); },
    /** Muzzle tip mapped through the viewmodel projection back into the world camera's space. */
    muzzleWorld(worldCamera, out) {
      muzzleView(_muzzleView);
      const depth = Math.max(0.2, -_muzzleView.z);
      _v.copy(_muzzleView).applyMatrix4(camera.projectionMatrix);                   // viewmodel NDC
      _v.set(_v.x, _v.y, 0.5).applyMatrix4(worldCamera.projectionMatrixInverse);    // world-camera view ray
      _v.multiplyScalar(depth / -_v.z);
      _f.copy(_v).applyMatrix4(worldCamera.matrixWorld);
      out[0] = _f.x; out[1] = _f.y; out[2] = _f.z;
      return out;
    },
    dispose() { geometry.dispose(); mesh.material.dispose(); burstGeo.dispose(); burst.material.dispose(); },
  };
}
