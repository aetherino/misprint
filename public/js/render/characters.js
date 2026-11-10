// PRINT-HEADS: remote players. One merged, palette-skinned mesh per character (body + ink rim hull),
// a CRT pixel face, a name tag and an instanced halftone blob shadow. All animation is procedural.
import * as THREE from 'three';
import { INKS, PLAYER, F } from '/shared/constants.js';
import { inkMaterial, setHex, quadGeometry, FONT_HEAVY } from './common.js';
import { RigBuilder, PAL, setPart, setChildPart, hidePart } from './geo.js';
import { makeRigUniforms, rigMaterial } from './rig.js';
import { addWeapon, addHand } from './models.js';
import { createFace } from './faces.js';

const TORSO = 0, HEAD = 1, LEG_L = 2, LEG_R = 3, HAND_L = 4, HAND_R = 5, WEAPON0 = 6, NPARTS = 10;
const HIP = 0.5, NECK = 0.7, TOP = 1.92;
const MAX_SHADOWS = 16;
const TWO_HANDED = [false, false, true, true];

function buildGeometry() {
  const b = new RigBuilder();
  const PI = Math.PI;
  // torso (pivot: hips): ink body, belt, a sheet of paper feeding out of the chest slot, cartridge backpack
  b.box(0.56, 0.62, 0.38, { p: [0, 0.34, 0], taper: [1.2, 1.06], part: TORSO, pal: PAL.INK });
  b.box(0.6, 0.1, 0.42, { p: [0, 0.05, 0], part: TORSO, pal: PAL.DARK });
  b.box(0.38, 0.045, 0.04, { p: [0, 0.4, -0.2], part: TORSO, pal: PAL.DARK });
  b.box(0.3, 0.2, 0.014, { p: [0, 0.285, -0.218], r: [-0.14, 0, 0], part: TORSO, pal: PAL.PAPER });
  b.box(0.38, 0.36, 0.15, { p: [0, 0.37, 0.255], part: TORSO, pal: PAL.ACCENT });
  b.ball(0.1, { p: [-0.37, 0.56, 0], part: TORSO, pal: PAL.DARK, seg: 10 });
  b.ball(0.1, { p: [0.37, 0.56, 0], part: TORSO, pal: PAL.DARK, seg: 10 });
  b.cyl(0.09, 0.11, 0.1, { p: [0, 0.69, 0], part: TORSO, pal: PAL.DARK, seg: 10 });
  // head (pivot: neck): CRT monitor with an ink cap, bezel, screen, knobs and an antenna
  b.box(0.74, 0.56, 0.46, { p: [0, 0.34, -0.03], part: HEAD, pal: PAL.PAPER });
  b.box(0.46, 0.36, 0.16, { p: [0, 0.34, 0.27], part: HEAD, pal: PAL.PAPER });
  b.box(0.78, 0.09, 0.5, { p: [0, 0.665, -0.03], part: HEAD, pal: PAL.INK });
  b.box(0.57, 0.42, 0.03, { p: [0, 0.345, -0.262], part: HEAD, pal: PAL.DARK });
  b.plane(0.5, 0.36, { p: [0, 0.345, -0.279], r: [0, PI, 0], part: HEAD, pal: PAL.SCREEN });
  b.cyl(0.07, 0.07, 0.05, { p: [-0.39, 0.3, 0], r: [0, 0, PI / 2], part: HEAD, pal: PAL.ACCENT, seg: 10 });
  b.cyl(0.07, 0.07, 0.05, { p: [0.39, 0.3, 0], r: [0, 0, PI / 2], part: HEAD, pal: PAL.ACCENT, seg: 10 });
  b.cyl(0.014, 0.014, 0.17, { p: [0.21, 0.76, 0.06], part: HEAD, pal: PAL.DARK, seg: 6 });
  b.ball(0.05, { p: [0.21, 0.87, 0.06], part: HEAD, pal: PAL.INK, seg: 8 });
  // stubby legs (pivot: hip joint) with chunky ink boots
  for (const part of [LEG_L, LEG_R]) {
    b.cyl(0.08, 0.07, 0.36, { p: [0, -0.2, 0], part, pal: PAL.DARK, seg: 8 });
    b.box(0.21, 0.16, 0.38, { p: [0, -0.42, -0.06], part, pal: PAL.INK });
  }
  addHand(b, HAND_L, -1);
  addHand(b, HAND_R, 1);
  for (let w = 0; w < 4; w++) addWeapon(b, w, WEAPON0 + w, WEAPON0 + w);
  const g = b.build();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.2);
  return g;
}

const TAG_VERT = /* glsl */`
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float k = clamp(-mv.z / 12.0, 1.0, 3.2);     // stays legible at range
  mv.xy += position.xy * uSize * k + vec2(0.0, uSize.y * (k - 1.0));
  gl_Position = projectionMatrix * mv;
  placeDepth();
}
`;
const TAG_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uTint;
uniform float uHp;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float fill = t.r, line = t.g;
  // hp pips along the bottom edge
  vec2 q = vec2((vUv.x - 0.5) * 4.0 / 0.72 + 2.5, vUv.y / 0.2);
  if (q.y < 1.0 && q.x > 0.0 && q.x < 5.0) {
    vec2 c = fract(q) - 0.5;
    float box = step(max(abs(c.x) * 1.15, abs(c.y) * 1.3), 0.5);
    float inner = step(max(abs(c.x) * 1.15, abs(c.y) * 1.3), 0.3);
    float on = step(floor(q.x) + 0.5, uHp * 5.0);
    line = max(line, box * (1.0 - inner * on));
    fill = max(fill, inner * on);
  }
  if (max(fill, line) < 0.5) discard;
  emit(uTint, 0.0, fill > 0.5 ? 0.0 : 1.0, vec3(0.0));
}
`;

const SHADOW_VERT = /* glsl */`
attribute vec4 aBlob;      // xyz centre on the ground, w radius
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = position.xy;
  vW = aBlob.xyz + vec3(position.x, 0.0, position.y) * aBlob.w + vec3(0.0, 0.025, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
  placeDepth();
}
`;
const SHADOW_FRAG = /* glsl */`
varying vec2 vUv;
varying vec3 vW;
void main() {
  float r = dot(vUv, vUv);
  if (r > 1.0) discard;
  float ink = halftone(vW.xz, lodDist(vW, vec3(0.0, 1.0, 0.0)), (1.0 - r) * 0.85);
  gl_FragColor = vec4(0.0);
  gLine = vec4(0.0, 0.0, 0.0, ink * (1.0 - fogAmt(length(vW - cameraPosition))));
}
`;

function drawTag(ctx, name) {
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 64);
  let size = 38;
  ctx.font = `${size}px ${FONT_HEAVY}`;
  const w = ctx.measureText(name).width;
  if (w > 236) { size *= 236 / w; ctx.font = `${size}px ${FONT_HEAVY}`; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 9;
  ctx.strokeText(name, 128, 28);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ff0000';
  ctx.fillText(name, 128, 28);
}

const lerp = (a, b, k) => a + (b - a) * k;
const approach = (a, b, dt, rate) => a + (b - a) * (1 - Math.exp(-rate * dt));

export function createCharacters({ scene, groundAt }) {
  const geometry = buildGeometry();
  const tagGeo = quadGeometry();
  const chars = new Map();

  // --- blob shadows: one instanced draw for everyone ---
  const blobData = new Float32Array(MAX_SHADOWS * 4);
  const blobGeo = new THREE.InstancedBufferGeometry();
  const quad = quadGeometry();
  blobGeo.setAttribute('position', quad.attributes.position);
  blobGeo.setIndex(quad.index);
  const blobAttr = new THREE.InstancedBufferAttribute(blobData, 4);
  blobAttr.setUsage(THREE.DynamicDrawUsage);
  blobGeo.setAttribute('aBlob', blobAttr);
  blobGeo.instanceCount = 0;
  const blobMesh = new THREE.Mesh(blobGeo, inkMaterial({ vertex: SHADOW_VERT, fragment: SHADOW_FRAG, blend: 'inkAdd', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  blobMesh.frustumCulled = false;
  blobMesh.renderOrder = 5;
  scene.add(blobMesh);

  function applyInfo(c, info) {
    c.info = { ...c.info, ...info };
    setHex(c.uniforms.uTint.value, INKS[(c.info.color | 0) % INKS.length].hex);
    drawTag(c.tagCtx, String(c.info.name ?? '').slice(0, 16) || '???');
    c.tagTex.needsUpdate = true;
    c.faceKey = '';
  }

  function add(id, info) {
    if (chars.has(id)) remove(id);
    const uniforms = makeRigUniforms(NPARTS);
    const face = createFace();
    uniforms.uFace.value = face.texture;
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const body = new THREE.Mesh(geometry, rigMaterial('body', NPARTS, uniforms));
    const hull = new THREE.Mesh(geometry, rigMaterial('hull', NPARTS, uniforms));
    const ghost = new THREE.Mesh(geometry, rigMaterial('ghost', NPARTS, uniforms));
    ghost.visible = false;
    ghost.renderOrder = 8;
    root.add(body, hull, ghost);
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const tagTex = new THREE.CanvasTexture(canvas);
    tagTex.colorSpace = THREE.NoColorSpace;
    const tag = new THREE.Mesh(tagGeo, inkMaterial({
      vertex: TAG_VERT, fragment: TAG_FRAG,
      uniforms: { uMap: { value: tagTex }, uTint: uniforms.uTint, uHp: { value: 1 }, uSize: { value: new THREE.Vector2(0.62, 0.155) } },
    }));
    tag.frustumCulled = false;
    scene.add(root, tag);
    const c = {
      info: {}, uniforms, face, root, body, hull, ghost, tag, tagTex, tagCtx: canvas.getContext('2d'),
      phase: Math.random() * 6, run: 0, crouch: 0, slide: 0, air: 0, wall: 0, dash: 0, reload: 0,
      squash: 0, squashVel: 0, hurt: 0, fire: 0, print: 1, emote: 0, exprT: 0, expr: 'idle',
      blink: 1 + Math.random() * 3, wasGround: true, lastVy: 0, alive: true, shadow: [0, 0, 0, 0],
      seen: false,
      state: { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, flags: 1, weapon: 0, alive: true, scale: 1, headScale: 1, ghost: false, hpFrac: 1 },
    };
    chars.set(id, c);
    applyInfo(c, info || {});
    root.visible = tag.visible = false;   // until the first updatePlayer
    return c;
  }

  function remove(id) {
    const c = chars.get(id);
    if (!c) return;
    scene.remove(c.root, c.tag);
    c.body.material.dispose(); c.hull.material.dispose(); c.ghost.material.dispose(); c.tag.material.dispose();
    c.tagTex.dispose(); c.face.dispose();
    chars.delete(id);
  }

  // The engine may reuse its state objects between calls, so keep our own copy.
  function update(id, s) {
    const c = chars.get(id);
    if (!c) return;
    const t = c.state;
    t.pos[0] = s.pos[0]; t.pos[1] = s.pos[1]; t.pos[2] = s.pos[2];
    if (s.vel) { t.vel[0] = s.vel[0]; t.vel[1] = s.vel[1]; t.vel[2] = s.vel[2]; }
    t.yaw = s.yaw || 0; t.pitch = s.pitch || 0; t.flags = s.flags | 0; t.weapon = s.weapon | 0;
    t.alive = s.alive !== false; t.scale = s.scale || 1; t.headScale = s.headScale || 1;
    t.ghost = !!s.ghost; t.hpFrac = s.hpFrac ?? 1;
    c.seen = true;
  }

  // Pose one character from its latest state. Rig space: feet at origin, facing -Z.
  function pose(c, dt, time) {
    const s = c.state;
    const A = c.uniforms.uPart.value;
    const fl = s.flags | 0;
    const alive = !!s.alive && !(fl & F.DEAD);
    const ghost = !!s.ghost || !!(fl & F.GHOST);
    c.body.visible = c.hull.visible = alive && !ghost;
    c.ghost.visible = alive && ghost;
    c.tag.visible = alive && !ghost;
    c.root.visible = alive;
    c.shadow[3] = 0;
    if (!alive) return;

    const scale = s.scale || 1;
    const ground = !!(fl & F.GROUND), sliding = !!(fl & F.SLIDE);
    const vx = s.vel[0], vy = s.vel[1], vz = s.vel[2];
    const sn = Math.sin(s.yaw), cs = Math.cos(s.yaw);
    const vf = -vx * sn - vz * cs, vr = vx * cs - vz * sn;
    const speed = Math.hypot(vx, vz);

    // landing squash (spring), blends
    if (ground && !c.wasGround && c.lastVy < -3) c.squashVel += Math.min(9, -c.lastVy * 0.55);
    c.wasGround = ground; c.lastVy = vy;
    // explicit spring: sub-step so a long frame cannot blow it up
    for (let left = Math.min(dt, 0.25); left > 1e-6; left -= 1 / 60) {
      const h = Math.min(left, 1 / 60);
      c.squashVel += (-c.squash * 190 - c.squashVel * 16) * h;
      c.squash += c.squashVel * h;
    }
    c.run = approach(c.run, ground && !sliding ? Math.min(1, speed / 7) : 0, dt, 12);
    c.crouch = approach(c.crouch, fl & F.CROUCH && !sliding ? 1 : 0, dt, 14);
    c.slide = approach(c.slide, sliding ? 1 : 0, dt, 14);
    c.air = approach(c.air, ground ? 0 : 1, dt, 10);
    c.wall = approach(c.wall, fl & F.WALL_L ? 1 : fl & F.WALL_R ? -1 : 0, dt, 10);
    c.dash = approach(c.dash, fl & F.DASH ? 1 : 0, dt, 22);
    c.reload = approach(c.reload, fl & F.RELOAD ? 1 : 0, dt, 10);
    c.phase += speed * dt * 2.5 * (ground ? 1 : 0.25);
    c.hurt = Math.max(0, c.hurt - dt * 5);
    c.fire = Math.max(0, c.fire - dt * 8);
    c.emote = Math.max(0, c.emote - dt);
    if (c.print < 1) c.print = Math.min(1, c.print + dt / 0.6);
    c.uniforms.uHurt.value = c.hurt * c.hurt;
    c.uniforms.uPrint.value.set(c.print * (TOP + 0.3), c.print < 1 ? 1 : 0);
    c.uniforms.uCharge.value = fl & F.CHARGE ? 0.8 : 0;

    // root: position, facing, wall-run roll, dash stretch, land squash
    const sq = c.squash;
    const hop = c.emote > 0 ? Math.abs(Math.sin(c.emote * 10)) * 0.18 : 0;
    c.root.position.set(s.pos[0], s.pos[1] + hop * scale, s.pos[2]);
    c.root.rotation.set(-0.35 * c.dash - 0.08 * c.air, s.yaw, -0.34 * c.wall - (vr / 8) * 0.1 * c.run);
    c.root.scale.set(scale * (1 + 0.24 * sq - 0.12 * c.dash), scale * (1 - 0.3 * sq - 0.06 * c.dash), scale * (1 + 0.24 * sq + 0.4 * c.dash));

    const swing = Math.sin(c.phase) * c.run;
    const fwdK = speed > 0.5 ? vf / speed : 1, sideK = speed > 0.5 ? vr / speed : 0;
    const hipY = HIP - 0.21 * c.crouch - 0.2 * c.slide + Math.abs(Math.cos(c.phase)) * 0.05 * c.run;
    const lean = -0.16 * c.run * fwdK - 0.34 * c.crouch + 0.85 * c.slide;
    const pitch = Math.max(-1.2, Math.min(1.2, s.pitch || 0));

    setPart(A, TORSO, 0, hipY, 0.12 * c.slide, lean, 0, 0);
    const hs = s.headScale || 1;
    setChildPart(A, HEAD, TORSO, 0, NECK, 0, pitch * 0.7 - lean * 0.85, 0, Math.sin(time * 1.7 + c.phase) * 0.03 + 0.5 * Math.sin(c.emote * 12) * Math.min(1, c.emote), hs);

    // legs: run cycle / crouch tuck / slide kick / air tuck
    const legLen = 1 - 0.36 * c.crouch - 0.25 * c.slide;
    const ls = swing * 1.0;
    const tuckL = lerp(ls * fwdK, 0.55, c.air) + 0.55 * c.crouch + 1.3 * c.slide;
    const tuckR = lerp(-ls * fwdK, -0.4, c.air) + 0.45 * c.crouch + 1.05 * c.slide;
    setPart(A, LEG_L, -0.16, hipY, 0, tuckL, 0, -ls * sideK * 0.6 - 0.25 * c.crouch, 1, legLen, 1);
    setPart(A, LEG_R, 0.16, hipY, 0, tuckR, 0, -ls * sideK * 0.6 + 0.25 * c.crouch, 1, legLen, 1);

    // right hand aims the weapon from the shoulder; fire kicks it back, reload drops it
    const aim = pitch * 0.85 - 0.5 * c.reload - 0.3 * c.slide + c.fire * 0.22;
    const ca = Math.cos(aim), sa = Math.sin(aim);
    const reach = 0.36 - c.fire * 0.09;
    const shY = hipY + 0.5, hx = 0.31;
    const emo = Math.min(1, c.emote * 3);
    setPart(A, HAND_R, hx, shY - 0.1 * ca + reach * sa + 0.5 * emo, -reach * ca - 0.1 * sa - 0.04, aim, -0.1, 0);
    const w = (s.weapon | 0) & 3;
    for (let k = 0; k < 4; k++) {
      if (k === w) setChildPart(A, WEAPON0 + k, HAND_R, 0, 0.06, -0.02, 0, 0, 0, 1.4);
      else hidePart(A, WEAPON0 + k);
    }
    const supporting = (TWO_HANDED[w] || c.reload > 0.3) && emo < 0.5;
    if (supporting) setChildPart(A, HAND_L, HAND_R, -0.2 - 0.2 * hx, 0.0 - 0.06 * c.reload * Math.sin(time * 14), -0.3, 0, 0.5, 0);
    else setPart(A, HAND_L, -0.4, hipY + 0.3 + 0.7 * emo + 0.1 * c.air, -0.06 - swing * 0.26 * fwdK - 0.1 * c.slide, swing * 0.5, 0, 0.3 * emo * Math.sin(time * 16));

    // face
    c.exprT -= dt;
    c.blink -= dt;
    if (c.blink < -0.12) c.blink = 1.5 + Math.random() * 3.5;
    const expr = c.exprT > 0 ? c.expr : c.blink < 0 ? 'blink' : 'idle';
    c.face.draw(c.info.face | 0, expr, pitch * 2.2, (time * 7) | 0);

    // name tag + blob shadow
    c.tag.position.set(s.pos[0], s.pos[1] + (TOP + 0.1 + (hs - 1) * 0.6 - 0.4 * c.crouch - 0.5 * c.slide) * scale + 0.22, s.pos[2]);
    c.tag.material.uniforms.uHp.value = s.hpFrac ?? 1;
    if (!ghost) {
      const gy = groundAt(s.pos[0], s.pos[1] + 0.3, s.pos[2]);
      const h = Math.max(0, s.pos[1] - gy);
      c.shadow[0] = s.pos[0]; c.shadow[1] = gy; c.shadow[2] = s.pos[2];
      c.shadow[3] = gy > -1e3 ? PLAYER.radius * 1.55 * scale * Math.max(0.35, 1 - h * 0.09) : 0;
    }
  }

  return {
    add, remove, update,
    setInfo(id, info) { const c = chars.get(id); if (c) applyInfo(c, info || {}); },
    event(id, kind) {
      const c = chars.get(id);
      if (!c) return;
      if (kind === 'fire') { c.fire = 1; c.expr = 'fire'; c.exprT = 0.22; }
      else if (kind === 'hurt') { c.hurt = 1; c.expr = 'hurt'; c.exprT = 0.4; }
      else if (kind === 'die') { c.expr = 'dead'; c.exprT = 3; }
      else if (kind === 'spawn') { c.print = 0; c.exprT = 0; c.squash = 0; c.squashVel = 0; }
      else if (kind === 'rewind') { c.print = 0.45; c.hurt = 0.6; }
      else if (kind === 'dash') c.dash = 1;
      else if (kind === 'jump') c.squashVel -= 5;
      else if (kind === 'emote') c.emote = 1.4;
    },
    tick(dt, time) {
      let n = 0;
      for (const c of chars.values()) {
        if (!c.seen) continue;
        pose(c, dt, time);
        if (c.shadow[3] > 0 && n < MAX_SHADOWS) { blobData.set(c.shadow, n * 4); n++; }
      }
      blobGeo.instanceCount = n;
      blobMesh.visible = n > 0;
      if (n) blobAttr.needsUpdate = true;
    },
    dispose() {
      for (const id of [...chars.keys()]) remove(id);
      geometry.dispose(); tagGeo.dispose(); blobGeo.dispose(); quad.dispose(); blobMesh.material.dispose();
      scene.remove(blobMesh);
    },
  };
}
