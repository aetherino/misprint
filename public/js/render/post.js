// The "printing press": owns the offscreen plates and the single fullscreen composite that
// inks outlines (depth + normal edges), prints the colour plates out of register, adds paper
// grain / ink mottle and all fullscreen event overlays.
import * as THREE from 'three';
import { shared, GLSL_LIB, DEPTH_WORLD, DEPTH_VIEW } from './common.js';

function grainTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let s = 1234567;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const fibers = new Float32Array(N * N);
  for (let i = 0; i < 520; i++) {
    let x = rnd() * N, y = rnd() * N;
    let a = rnd() * Math.PI * 2;
    const len = 4 + rnd() * 14, w = 0.2 + rnd() * 0.5;
    for (let k = 0; k < len; k++) {
      fibers[((y | 0) & 255) * N + ((x | 0) & 255)] += w;
      x += Math.cos(a); y += Math.sin(a); a += (rnd() - 0.5) * 0.5;
    }
  }
  const lattice = (cell) => {
    const n = N / cell, g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x, y) => {
      const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (a, b) => g[((b + n) % n) * n + ((a + n) % n)];
      return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
    };
  };
  const big = lattice(32), mid = lattice(8);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    data[i] = 255 * (rnd() * 0.6 + rnd() * 0.4);                              // tooth
    data[i + 1] = 255 * Math.min(1, fibers[y * N + x]);                       // fibers
    data[i + 2] = 255 * Math.min(1, big(x, y) * 0.6 + mid(x, y) * 0.4);       // ink mottle
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const COMPOSITE_FRAG = /* glsl */`
${GLSL_LIB}
uniform sampler2D tColor;
uniform sampler2D tLine;
uniform sampler2D tDepth;
uniform sampler2D tGrain;
uniform vec2 uPx;          // one output pixel in uv
uniform vec2 uRes;         // output size in px
uniform vec4 uCam;         // world camera: near, far, depth scale, depth offset
uniform vec4 uCamV;        // viewmodel camera: same layout
uniform float uPxScale;    // output height / 1080
uniform float uMisreg;     // base plate offset in px (at 1080p)
uniform float uKick;       // transient misregistration 0..1
uniform float uDamage;
uniform float uLowHp;
uniform float uHeal;
uniform float uOver;       // overprint flash
uniform float uOverOn;     // overprint held
uniform float uKill;
uniform float uRewind;     // 0 idle, (0,1] sweep progress
uniform float uSpeed;      // speed-line amount
uniform vec4 uBurst;       // uv.xy, radius (in screen heights), strength
uniform vec3 uBurstColor;
varying vec2 vUv;

const vec3 RED = vec3(1.0, 0.29, 0.2);
const vec3 MINT = vec3(0.1, 0.79, 0.54);
const vec3 GOLD = vec3(1.0, 0.82, 0.12);

// 1 / view depth. The viewmodel owns the near slice of the depth range with its own projection.
float invZ(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  if (d < uCamV.z) {
    float zv = (2.0 * d - 1.0 - uCamV.w) / uCamV.z;
    return (uCamV.y + uCamV.x - zv * (uCamV.y - uCamV.x)) / (2.0 * uCamV.x * uCamV.y);
  }
  float zn = ((2.0 * d - 1.0) - uCam.w) / uCam.z;
  return (uCam.y + uCam.x - zn * (uCam.y - uCam.x)) / (2.0 * uCam.x * uCam.y);
}

// screen-space halftone, only for fullscreen overlays
float screenDots(vec2 frag, float period, float cov) {
  vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * frag / period;
  float r = sqrt(clamp(cov, 0.0, 1.0) * 0.5);
  return 1.0 - smoothstep(r - 0.08, r + 0.08, length(fract(q) - 0.5));
}

void main() {
  vec2 uv = vUv;
  vec2 frag = uv * uRes;
  float aspect = uRes.x / uRes.y;
  vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
  float r2 = dot(c, c) / (0.25 * (aspect * aspect + 1.0));   // 0 centre .. 1 corners

  // --- rewind: a paper-feed tear sweeping down the page ---
  float tear = 0.0;
  if (uRewind > 0.0) {
    float y0 = 1.08 - uRewind * 1.16;
    float d = uv.y - y0;
    tear = smoothstep(0.09, 0.0, abs(d));
    float row = floor(uv.y * uRes.y / (3.0 * uPxScale + 1.0));
    uv.x += tear * (hash21(vec2(row, floor(uTime * 40.0))) - 0.5) * 0.09;
    uv.x += step(0.0, d) * 0.012 * sin(uTime * 50.0);          // unprinted part of the sheet slips
    uv.y += tear * 0.01;
  }

  // --- line plate: stays in register ---
  float qc = invZ(uv);
  float dist = 1.0 / qc;
  vec2 px = uPx * (dist < 3.0 ? 1.35 : 1.0) * max(1.0, uPxScale * 0.9);
  vec4 Lc = texture2D(tLine, uv);
  // normals coded as "neutral" (sky, rim hulls, blended fx) never raise a crease line
  float solid = step(0.1, length(Lc.rgb - 0.5));
#if QUALITY > 0
  vec2 o1 = vec2(px.x, 0.0), o2 = vec2(0.0, px.y);
  float ql = invZ(uv - o1), qr = invZ(uv + o1), qd = invZ(uv - o2), qu = invZ(uv + o2);
  float lap = abs(ql + qr - 2.0 * qc) + abs(qu + qd - 2.0 * qc);
  vec3 nl = texture2D(tLine, uv - o1).rgb, nr = texture2D(tLine, uv + o1).rgb;
  vec3 nd = texture2D(tLine, uv - o2).rgb, nu = texture2D(tLine, uv + o2).rgb;
  float nDiff = length(nl - Lc.rgb) * step(0.1, length(nl - 0.5)) + length(nr - Lc.rgb) * step(0.1, length(nr - 0.5))
    + length(nd - Lc.rgb) * step(0.1, length(nd - 0.5)) + length(nu - Lc.rgb) * step(0.1, length(nu - 0.5));
#else
  float qr = invZ(uv + vec2(px.x, 0.0)), qu = invZ(uv + vec2(0.0, px.y));
  float lap = 2.0 * (abs(qr - qc) + abs(qu - qc)) * step(0.02, abs(qr - qc) / qc + abs(qu - qc) / qc);
  vec3 nr = texture2D(tLine, uv + vec2(px.x, 0.0)).rgb, nu = texture2D(tLine, uv + vec2(0.0, px.y)).rgb;
  float nDiff = 1.6 * (length(nr - Lc.rgb) * step(0.1, length(nr - 0.5)) + length(nu - Lc.rgb) * step(0.1, length(nu - 0.5)));
#endif
  nDiff *= solid;
  float edge = max(smoothstep(0.012, 0.03, lap / qc), smoothstep(0.3, 0.6, nDiff));
  edge *= 1.0 - 0.75 * fogAmt(dist);
  float ink = max(Lc.a, edge);

  // --- colour plates: offset from the line plate, more toward the page edges ---
  float mis = (uMisreg * (0.18 + 1.5 * smoothstep(0.0, 1.0, r2)) + uKick * 7.0) * uPxScale;
  float ang = 0.65 + 0.3 * sin(uTime * 0.55) + uKick * 2.0 * sin(uTime * 31.0);
  vec2 dirA = vec2(cos(ang), sin(ang));
  vec2 offA = dirA * mis * uPx;
#if QUALITY > 0
  vec2 offB = vec2(-dirA.y, dirA.x * 0.6 - 0.5) * mis * uPx;
  vec4 cA = texture2D(tColor, uv + offA);
  vec4 cB = texture2D(tColor, uv + offB);
  vec3 col = cA.a < 0.5 ? cA.rgb : uPaper;                       // plate A (gaps show bare paper)
  if (cB.a > 0.5) col = cB.rgb * min(col / max(uPaper, vec3(0.05)), vec3(1.0));   // plate B overprints
#else
  vec3 col = texture2D(tColor, uv + offA).rgb;
#endif

  // --- localized comic impact frame (deaths): two-tone posterize inside a spiky burst ---
  if (uBurst.w > 0.0) {
    vec2 bc = (uv - uBurst.xy) * vec2(aspect, 1.0);
    float ba = atan(bc.y, bc.x);
    float br = uBurst.z * (1.0 + 0.22 * sin(ba * 13.0 + 1.3) + 0.12 * sin(ba * 29.0));
    float inside = step(length(bc), br) * uBurst.w;
    float lum = dot(col, vec3(0.3, 0.55, 0.15)) * (1.0 - ink);
    vec3 two = lum > 0.42 ? uPaper : uBurstColor;
    col = mix(col, two, inside);
    ink = mix(ink, step(lum, 0.12), inside);
  }

  // --- paper + ink ---
  vec3 g = texture2D(tGrain, frag / (256.0 * max(1.0, floor(uPxScale + 0.5)))).rgb;
  float paperness = 1.0 - clamp(length(col - uPaper) * 2.0, 0.0, 1.0);
  col = mix(uPaper, col, 0.9 + 0.14 * g.b + 0.06 * paperness);                       // uneven ink laydown
  col *= 1.0 - 0.06 * (g.r - 0.5) - 0.03 * g.g * (0.3 + paperness);                 // tooth + fibres
  float salt = smoothstep(0.86, 0.95, g.r) * 0.45;
  col = mix(col, uInk * (0.92 + 0.3 * g.b), ink * (0.9 + 0.1 * g.b) * (1.0 - salt));

  // --- overlays (screen-space print effects) ---
  float rim = smoothstep(0.25, 1.0, r2);
  if (uSpeed > 0.001) {
    float a = atan(c.y, c.x);
    float seg = floor(a * 40.0 + floor(uTime * 14.0) * 3.7);
    float h = hash11(seg);
    float lineAA = abs(fract(a * 40.0) - 0.5) * 2.0;
    float streak = step(0.7, h) * smoothstep(0.92 - 0.3 * uSpeed * h, 1.2, sqrt(r2) + 0.3 * h) * (1.0 - smoothstep(0.15 + 0.35 * h, 0.7, lineAA));
    col = mix(col, uInk, streak * min(1.0, uSpeed * 1.5) * 0.85);
  }
  float dmg = max(uDamage, uLowHp * (0.3 + 0.08 * sin(uTime * 5.0)));
  if (dmg > 0.001) {
    float d = screenDots(frag, 9.0 * uPxScale, dmg * rim * 1.25);
    col = mix(col, col * RED * 0.9 + RED * 0.12, d);
  }
  if (uHeal > 0.001) {
    float d = screenDots(frag, 9.0 * uPxScale, uHeal * smoothstep(0.55, 1.0, max(r2, 1.0 - uv.y - (1.0 - uHeal))) * 0.9);
    col = mix(col, MINT, d * 0.9);
  }
  float over = max(uOver * (0.35 + 0.65 * rim), uOverOn * rim * (0.42 + 0.06 * sin(uTime * 6.0)));
  if (over > 0.001) {
    float d = screenDots(frag + vec2(uTime * 14.0, 0.0), 11.0 * uPxScale, over);
    col = mix(col, col * GOLD + GOLD * 0.18, d);
  }
  if (uKill > 0.001) {
    vec2 e = min(uv, 1.0 - uv) * uRes / uPxScale;
    float frame = 1.0 - smoothstep(10.0 * uKill, 10.0 * uKill + 2.0, min(e.x, e.y));
    col = mix(col, uInk, frame);
  }
  if (uRewind > 0.0) {
    col = mix(col, uPaper, tear * 0.55 * step(0.5, fract(frag.y / (4.0 * uPxScale + 1.0))));
    col = mix(col, uSpotB, tear * 0.25);
  }
  col *= 1.0 - 0.16 * r2 * r2;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createPost(renderer) {
  const depthTexture = new THREE.DepthTexture(4, 4);
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
  let target = null;
  let samples = 0;

  const makeTarget = (w, h) => {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 2, depthTexture, samples, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, stencilBuffer: false,
    });
    for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
    return rt;
  };
  target = makeTarget(4, 4);

  const uniforms = {
    ...shared,
    tColor: { value: target.textures[0] },
    tLine: { value: target.textures[1] },
    tDepth: { value: depthTexture },
    tGrain: { value: grainTexture() },
    uPx: { value: new THREE.Vector2(1, 1) },
    uRes: { value: new THREE.Vector2(1, 1) },
    uCam: { value: new THREE.Vector4(0.05, 500, DEPTH_WORLD.value.x, DEPTH_WORLD.value.y) },
    uCamV: { value: new THREE.Vector4(0.03, 8, DEPTH_VIEW.value.x, DEPTH_VIEW.value.y) },
    uPxScale: { value: 1 },
    uMisreg: { value: 2.2 },
    uKick: { value: 0 },
    uDamage: { value: 0 }, uLowHp: { value: 0 }, uHeal: { value: 0 },
    uOver: { value: 0 }, uOverOn: { value: 0 }, uKill: { value: 0 },
    uRewind: { value: 0 }, uSpeed: { value: 0 },
    uBurst: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
    uBurstColor: { value: new THREE.Vector3(1, 0, 0) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { QUALITY: 1 },
    vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false, depthWrite: false,
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const ortho = new THREE.Camera();

  // event overlays decay here; held states come from setView
  const fx = { kick: 0, damage: 0, heal: 0, over: 0, kill: 0, rewind: 0, burst: 0, burstT: 0 };
  const held = { lowHp: 0, overOn: 0, rewind: 0, speed: 0 };

  return {
    get target() { return target; },
    uniforms,
    held,
    setSize(w, h, outW, outH) {
      target.setSize(w, h);
      uniforms.uPx.value.set(1 / outW, 1 / outH);
      uniforms.uRes.value.set(outW, outH);
      uniforms.uPxScale.value = outH / 1080;
      shared.uLod.value = 6 * 2.18 / outH;
    },
    setQuality(q) {
      const want = q >= 2 ? 4 : 0;
      if (want !== samples) {
        samples = want;
        const w = target.width, h = target.height;
        target.dispose();
        target = makeTarget(w, h);
        uniforms.tColor.value = target.textures[0];
        uniforms.tLine.value = target.textures[1];
      }
      material.defines.QUALITY = q;
      material.needsUpdate = true;
    },
    kick(amount) { fx.kick = Math.min(1, Math.max(fx.kick, amount)); },
    flash(kind) {
      if (kind === 'damage') { fx.damage = 1; fx.kick = Math.max(fx.kick, 0.7); }
      else if (kind === 'heal') fx.heal = 1;
      else if (kind === 'overprint') { fx.over = 1; fx.kick = Math.max(fx.kick, 0.4); }
      else if (kind === 'rewind') { fx.rewind = 0.0001; fx.kick = Math.max(fx.kick, 0.8); }
      else if (kind === 'kill') { fx.kill = 1; fx.kick = Math.max(fx.kick, 0.35); }
    },
    /** Comic impact frame around a screen position (uv), radius in screen heights. */
    burst(u, v, radius, rgb) {
      uniforms.uBurst.value.set(u, v, radius, 1);
      uniforms.uBurstColor.value.set(rgb[0], rgb[1], rgb[2]);
      fx.burst = radius; fx.burstT = 0;
      fx.kick = Math.max(fx.kick, 0.5);
    },
    clearFx() { for (const k in fx) fx[k] = 0; uniforms.uBurst.value.w = 0; },
    update(dt, camera, viewCamera) {
      const dec = (v, rate) => Math.max(0, v - dt * rate);
      fx.kick = dec(fx.kick, 3.2 + fx.kick * 4);
      fx.damage = dec(fx.damage, 2.2);
      fx.heal = dec(fx.heal, 1.8);
      fx.over = dec(fx.over, 1.4);
      fx.kill = dec(fx.kill, 5);
      if (fx.rewind > 0) { fx.rewind += dt / 0.45; if (fx.rewind >= 1) fx.rewind = 0; }
      if (fx.burst > 0) {
        fx.burstT += dt;
        const k = fx.burstT / 0.13;
        if (k >= 1) { fx.burst = 0; uniforms.uBurst.value.w = 0; }
        else uniforms.uBurst.value.z = fx.burst * (0.7 + 0.3 * Math.min(1, k * 4)) * (k > 0.75 ? 1 - (k - 0.75) * 3 : 1);
      }
      uniforms.uKick.value = fx.kick * fx.kick;
      uniforms.uDamage.value = fx.damage * fx.damage;
      uniforms.uLowHp.value = held.lowHp;
      uniforms.uHeal.value = fx.heal;
      uniforms.uOver.value = fx.over;
      uniforms.uOverOn.value = held.overOn;
      uniforms.uKill.value = fx.kill;
      uniforms.uRewind.value = Math.max(fx.rewind, held.rewind > 0 && held.rewind < 1 ? held.rewind : 0);
      uniforms.uSpeed.value = held.speed;
      uniforms.uCam.value.x = camera.near;
      uniforms.uCam.value.y = camera.far;
      uniforms.uCamV.value.x = viewCamera.near;
      uniforms.uCamV.value.y = viewCamera.far;
    },
    render() {
      renderer.setRenderTarget(null);
      renderer.render(scene, ortho);
    },
    dispose() { target.dispose(); depthTexture.dispose(); uniforms.tGrain.value.dispose(); tri.dispose(); material.dispose(); },
  };
}
