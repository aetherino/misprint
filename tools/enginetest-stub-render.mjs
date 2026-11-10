// Recording stand-in for public/js/render/index.js, served by `enginetest.mjs --stubs` so the
// engine can be tested in isolation (no WebGL). Same contract; every call is counted in window.__stub.
import * as THREE from 'three';

const log = (window.__stub ||= { calls: {}, last: {} });
const rec = (name) => (...args) => { log.calls[name] = (log.calls[name] || 0) + 1; log.last[name] = args; };
const group = (prefix, names) => Object.fromEntries(names.map((n) => [n, rec(`${prefix}.${n}`)]));

export async function createRenderer() {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 500);
  camera.rotation.order = 'YXZ';
  return {
    THREE, scene: new THREE.Scene(), camera,
    ...group('R', ['buildWorld', 'setPickups', 'addPlayer', 'removePlayer', 'setPlayerInfo', 'updatePlayer', 'playerEvent', 'setView', 'render', 'setOptions']),
    view: group('view', ['setWeapon', 'fire', 'reload', 'setCharge', 'setInk', 'setVisible']),
    fx: group('fx', ['tracer', 'impact', 'hitPlayer', 'explosion', 'death', 'ring', 'shake', 'flash']),
    projectile: group('projectile', ['spawn', 'move', 'remove']),
    muzzleWorldPos() { const v = new THREE.Vector3(0.25, -0.2, -0.8).applyMatrix4(camera.matrixWorld); return [v.x, v.y, v.z]; },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
  };
}
