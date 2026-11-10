// RENDER MODULE — "a first-person shooter printed on a risograph, slightly out of register".
// The exported function name and every method below are the interface the engine codes against
// (unchanged from the contract stub). Optional additions are documented in notes/art.md.
//
// Conventions: positions are [x,y,z] arrays (meters, Y up). Player `pos` is the FEET position.
// Colors are ink indices into INKS (shared/constants.js).
//
// Pipeline (2 fullscreen-sized passes total):
//   1. world + characters + fx, then the viewmodel (own camera, near depth slice) → two "plates" + depth
//   2. post.js composite: ink outlines, plate misregistration, paper grain, event overlays → screen
import * as THREE from 'three';
import { THEMES } from '/shared/constants.js';
import { shared, applyTheme, loadFonts } from './common.js';
import { createPost } from './post.js';
import { createSky } from './sky.js';
import { createWorld } from './world.js';
import { createDecals } from './decals.js';
import { createFx } from './fx.js';
import { createCharacters } from './characters.js';
import { createViewmodel } from './viewmodel.js';
import { createPickups } from './pickups.js';

const PIXEL_RATIO_CAP = [1, 1.5, 2];
const TARGET_SCALE = [0.8, 1, 1];

export async function createRenderer({ canvas }) {
  await loadFonts();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // shaders work in display-referred ink colours end to end
  renderer.setClearColor(0x000000, 0);
  renderer.info.autoReset = false;   // one frame = several render() calls; reset once per frame instead

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(95, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  const post = createPost(renderer);
  const sky = createSky();
  const world = createWorld(renderer);
  const decals = createDecals(scene);
  scene.add(sky.mesh, world.group);

  let map = null;
  // Highest walkable surface at or below y (for blob shadows).
  function groundAt(x, y, z) {
    let best = -Infinity;
    if (!map) return best;
    const boxes = map.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
      const top = b.max[1];
      if (top <= y && top > best) best = top;
    }
    return best;
  }

  const fx = createFx({ scene, decals, post });
  const characters = createCharacters({ scene, groundAt });
  const view = createViewmodel();
  const pickups = createPickups(scene);

  let quality = 1, cssW = 1, cssH = 1, outH = 1;
  let shake = 0, lastTime = 0;
  const savedPos = new THREE.Vector3(), savedRot = new THREE.Euler();
  fx.api.shake = (amount) => { shake = Math.min(1, Math.max(shake, amount || 0)); };

  function applySize() {
    const pr = Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[quality]);
    renderer.setPixelRatio(pr);
    renderer.setSize(cssW, cssH, false);
    const outW = Math.max(1, Math.floor(cssW * pr));
    outH = Math.max(1, Math.floor(cssH * pr));
    const k = TARGET_SCALE[quality];
    post.setSize(Math.max(1, Math.round(outW * k)), Math.max(1, Math.round(outH * k)), outW, outH);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    view.setAspect(cssW / cssH);
  }

  // Everything that advances with time but does not draw.
  function advance(dt, time) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    lastTime = time;
    shared.uTime.value = time;
    shake = Math.max(0, shake - dt * (1.6 + shake * 3));
    decals.setTime(time);
    fx.update(time, camera);
    characters.tick(dt, time);
    pickups.update(dt, time);
    view.update(dt);
    post.update(dt, camera, view.camera);
  }

  function draw() {
    // camera shake is applied only for the duration of the draw: the engine's pose is never altered
    const t = lastTime;
    savedPos.copy(camera.position); savedRot.copy(camera.rotation);
    if (shake > 0.001) {
      const a = shake * shake;
      camera.position.x += Math.sin(t * 61.0) * 0.05 * a;
      camera.position.y += Math.sin(t * 47.0 + 1.3) * 0.06 * a;
      camera.rotation.x += Math.sin(t * 53.0 + 0.7) * 0.02 * a;
      camera.rotation.y += Math.sin(t * 43.0 + 2.1) * 0.016 * a;
      camera.rotation.z += Math.sin(t * 37.0) * 0.035 * a;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    sky.mesh.position.copy(camera.position);
    sky.update(camera, outH);

    renderer.setRenderTarget(post.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.render(view.scene, view.camera);
    post.render();

    camera.position.copy(savedPos); camera.rotation.copy(savedRot);
    camera.updateMatrixWorld();
  }

  const R = {
    THREE, scene,
    /** Engine sets camera.position / camera.rotation (YXZ: pitch,yaw,roll) / camera.fov every frame. */
    camera,

    /** Build (or rebuild) the arena from a map object (see shared/mapgen.js). Clears decals + fx. */
    buildWorld(m) {
      map = m;
      const theme = THEMES[m.theme % THEMES.length] || THEMES[0];
      applyTheme(theme);
      decals.setMap(m);
      fx.clear();
      post.clearFx();
      shake = 0;
      world.build(m);
    },

    /** Full pickup list whenever it changes: [{ id, type:'health'|'overprint', pos, active:boolean }] */
    setPickups(list) { pickups.set(list); },

    /** Remote players (never called for the local player). info: { name, color, face, isBot } */
    addPlayer(id, info) { characters.add(id, info); },
    removePlayer(id) { characters.remove(id); },
    /** Update name/color/face of an existing player. */
    setPlayerInfo(id, info) { characters.setInfo(id, info); },
    /**
     * Called every frame per remote player with interpolated state:
     * { pos:[3], yaw, pitch, vel:[3], flags (F bitfield), weapon (0..3), alive:boolean,
     *   scale (body scale from cards), headScale (local player's Big Headline), ghost:boolean, hpFrac }
     */
    updatePlayer(id, s) { characters.update(id, s); },
    /** One-shot character events: 'fire' | 'hurt' | 'die' | 'spawn' | 'dash' | 'rewind' | 'jump' | 'emote' */
    playerEvent(id, kind) { characters.event(id, kind); },

    /** First-person viewmodel (local player's hands/weapon). */
    view: view.api,
    /**
     * Per-frame "feel" inputs for viewmodel sway/bob and screen-space effects:
     * { dt, speed (horizontal m/s), vel:[3], onGround, sliding, dashing, wallSide:-1|0|1,
     *   lookDelta:[dyaw,dpitch], hpFrac, overprint:boolean, rewind:0..1 (rewind fx progress), alive }
     */
    setView(state) {
      view.setFeel(state);
      const hp = state.hpFrac ?? 1;
      post.held.lowHp = state.alive === false ? 0 : Math.min(1, Math.max(0, (0.4 - hp) / 0.4));
      post.held.overOn = state.overprint ? 1 : 0;
      post.held.rewind = state.rewind || 0;
      const speed = state.speed || 0;
      post.held.speed = Math.min(1, Math.max(state.dashing ? 0.85 : 0, (speed - 13) / 12));
    },
    /** World-space position of the viewmodel muzzle — engine starts local tracers here. */
    muzzleWorldPos() {
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      return view.muzzleWorld(camera, [0, 0, 0]);
    },

    fx: fx.api,
    projectile: fx.projectile,

    /** Draw one frame. dt seconds, time seconds since start. */
    render(dt, time) { renderer.info.reset(); advance(dt, time); draw(); },
    resize(w, h) { cssW = Math.max(1, w | 0); cssH = Math.max(1, h | 0); applySize(); },
    /** { quality: 0 low | 1 medium | 2 high } — low must run 60fps on an old integrated GPU. */
    setOptions(opts) {
      if (!opts || opts.quality == null) return;
      const q = Math.min(2, Math.max(0, opts.quality | 0));
      if (q === quality) return;
      quality = q;
      post.setQuality(q);
      if (world.setQuality(q) && map) world.rebake(map);
      applySize();
    },

    // ---- optional additions (see notes/art.md) ----
    /** Advance animation/effect timers without drawing (tools, fast-forward). render() = advance() + draw(). */
    advance,
    /** { calls, triangles, geometries, textures, decals } of the last frame — for perf overlays/tests. */
    stats() {
      const i = renderer.info;
      return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : 0, decals: decals.count };
    },
    renderer,
  };
  R.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  view.update(0);
  return R;
}
