// Arena builder: turns map boxes into three merged meshes (floor / typographic walls / everything else),
// bakes a sun shadow map + floor contact-AO once per map, and prints the jump pads.
// All shading is flat tone + world-anchored halftone/hatch; decoration is per `kind`, ink per `tone`.
import * as THREE from 'three';
import { inkMaterial, SUN_DIR, FONT_DISPLAY, FONT_HEAVY, FONT_MONO, FONT_NARROW } from './common.js';

const KIND = { floor: 0, wall: 1, block: 2, crate: 3, tower: 4, pillar: 5, platform: 6, trim: 7 };
const KIND_DEFAULT = 8;
const SHADOW_SIZE = [1024, 2048, 2048];
const AO_N = 256;
const ATLAS_W = 2048, ATLAS_ROW = 256, ATLAS_ROWS = 4;

const VERT = /* glsl */`
attribute vec2 aUV;
attribute vec2 aDim;
attribute vec4 aStyle;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUV;
varying vec2 vDim;
varying vec4 vStyle;
void main() {
  vW = position; vN = normal; vUV = aUV; vDim = aDim; vStyle = aStyle;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  placeDepth();
}
`;

const LIGHT = /* glsl */`
uniform sampler2DShadow uShadow;
uniform mat4 uShadowMat;
varying vec3 vW;
varying vec3 vN;
varying vec2 vUV;
varying vec2 vDim;
varying vec4 vStyle;
// 1 = sunlit, 0 = in cast shadow
float sunlight(vec3 wp, vec3 n) {
  vec4 s = uShadowMat * vec4(wp + n * 0.07, 1.0);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return texture(uShadow, vec3(s.xy, s.z - 0.0012));
}
// printed "darkness" of a face: tone band from the sun, cast shadow, then contact AO
float faceDark(vec3 n, float ao) {
  float ndl = dot(n, uSunDir);
  float d = n.y > 0.5 ? 0.0 : (n.y < -0.5 ? 0.8 : clamp(0.36 - 0.75 * ndl, 0.0, 0.7));
  float lit = ndl > 0.0 ? sunlight(vW, n) : 0.0;
  d = mix(max(d, 0.52), d, lit);
  return clamp(d + ao, 0.0, 1.0);
}
float edgeDist() { return min(min(vUV.x, vDim.x - vUV.x), min(vUV.y, vDim.y - vUV.y)); }
float target(vec2 c, float R) {
  float l = length(c);
  float ring = band(abs(l - R), -1.0, R * 0.06);
  float ring2 = band(abs(l - R * 0.5), -1.0, R * 0.04);
  float hair = band(min(abs(c.x), abs(c.y)), -1.0, R * 0.05) * below(max(abs(c.x), abs(c.y)), R * 1.45);
  return max(max(ring, ring2), hair);
}
`;

const BOX_FRAG = LIGHT + /* glsl */`
void main() {
  vec3 n = normalize(vN);
  float dist = length(vW - cameraPosition), ld = lodDist(vW, n);
  vec2 p = planar(vW, n);
  float tone = vStyle.x, kind = vStyle.y;
  bool top = n.y > 0.5, side = abs(n.y) < 0.5;
  float ao = side ? vStyle.w * 0.34 * (1.0 - smoothstep(0.0, 1.2, vW.y - vStyle.z)) : 0.0;
  float dark = faceDark(n, ao);

  // --- per-kind print decoration: knock = bare paper, line = dark ink, spot = swap to the other spot ink ---
  float knock = 0.0, line = 0.0, spot = 0.0;
  float e = edgeDist();
  float fromTop = vDim.y - vUV.y;
  if (kind < 1.5) {                       // interior wall: paper belt + kick band
    if (side && kind > 0.5) {
      knock = band(vUV.y, 1.45, 1.75) * step(2.4, vDim.y);
      line = max(band(vUV.y, 1.39, 1.45), band(vUV.y, 1.75, 1.81)) * step(2.4, vDim.y);
      line = max(line, below(vUV.y, 0.22));
    }
  } else if (kind < 2.5) {                // block: hazard stripes under the lid
    if (side) {
      float st = step(0.5, fract((vUV.x + vUV.y) / 0.55));
      float z = band(fromTop, 0.0, 0.42);
      line = z * st; spot = z * (1.0 - st);
      line = max(line, band(fromTop, 0.42, 0.47));
    } else if (top) line = band(e, 0.25, 0.31);
  } else if (kind < 3.5) {                // crate: inset frame + brace
    line = band(e, 0.09, 0.16);
    if (side) {
      float dg = abs(vUV.x * vDim.y - vUV.y * vDim.x) / length(vDim);
      float dg2 = abs((vDim.x - vUV.x) * vDim.y - vUV.y * vDim.x) / length(vDim);
      line = max(line, below(min(dg, dg2), 0.035) * (1.0 - below(e, 0.16)));
    } else if (top) line = max(line, target(vUV - vDim * 0.5, min(vDim.x, vDim.y) * 0.2));
  } else if (kind < 4.5) {                // tower: ruler band up high, kick band, target on the roof
    if (side) {
      float z = band(fromTop, 0.45, 1.15);
      knock = z;
      float tick = fract(vUV.x / 0.5);
      float longT = step(fract(vUV.x / 2.0), 0.25);
      line = z * band(tick, 0.0, 0.14) * below(fromTop, 0.72 + 0.2 * longT);
      line = max(line, max(band(fromTop, 0.39, 0.45), band(fromTop, 1.15, 1.21)));
      line = max(line, below(vUV.y, 0.3));
    } else if (top) line = target(vUV - vDim * 0.5, min(vDim.x, vDim.y) * 0.28);
  } else if (kind < 5.5) {                // pillar: knocked-out rings + a spot cuff
    if (side) {
      knock = max(band(vUV.y, 1.0, 1.14), band(vUV.y, 1.26, 1.32));
      spot = band(fromTop, 0.35, 0.95) * step(3.0, vDim.y);
    }
  } else if (kind < 6.5) {                // platform: chevron edge, framed deck with a target
    if (side) {
      float ch = step(0.5, fract((vUV.x + abs(vUV.y - vDim.y * 0.5) * 1.2) / 0.5));
      line = ch * step(vDim.y, 1.2);
    } else if (top) {
      line = band(e, 0.2, 0.27);
      if (min(vDim.x, vDim.y) > 2.5) line = max(line, target(vUV - vDim * 0.5, min(vDim.x, vDim.y) * 0.24));
    }
  }

  vec3 col; float plate = 0.0, ink = 0.0;
  if (tone < 0.5) {                       // paper stock: spot-B dot tint in shade, hatch in deep shade
    float tint = halftone(p, ld, smoothstep(0.08, 0.9, dark) * 0.55);
    col = mix(uPaper, uSpotB, tint); plate = tint;
    ink = hatch(p, ld, smoothstep(0.6, 1.0, dark) * 0.35, 1.0);
    col = mix(col, uSpotA, spot); plate *= 1.0 - spot;
  } else if (tone < 1.5) {                // spot A: solid, ink dots for shade
    col = mix(uSpotA, uSpotB, spot); plate = spot;
    ink = halftone(p, ld, smoothstep(0.08, 1.0, dark) * 0.6);
  } else if (tone < 2.5) {                // spot B: solid, ink hatch for shade
    col = mix(uSpotB, uSpotA, spot); plate = 1.0 - spot;
    ink = hatch(p, ld, smoothstep(0.08, 1.0, dark) * 0.42, -1.0);
  } else {                                // dark ink: solid, paper dots knocked out where the sun hits
    col = mix(uPaper, uSpotA, spot);
    ink = 1.0 - max(spot, halftone(p, ld, (1.0 - smoothstep(0.0, 0.45, dark)) * 0.12));
    ink = max(ink, spot * halftone(p, ld, dark * 0.6));
  }
  if (knock > 0.0) {
    col = mix(col, uPaper, knock); plate *= 1.0 - knock;
    ink = mix(ink, hatch(p, ld, smoothstep(0.45, 1.0, dark) * 0.4, 1.0), knock);
  }
  ink = max(ink, line);

  float f = fogAmt(dist);
  emit(mix(col, uPaper, f), plate * (1.0 - f), ink * (1.0 - 0.8 * f), n);
}
`;

const FLOOR_FRAG = LIGHT + /* glsl */`
uniform sampler2D uAO;
uniform float uHalf;
void main() {
  vec3 n = vec3(0.0, 1.0, 0.0);
  float dist = length(vW - cameraPosition), ld = lodDist(vW, n);
  vec2 p = vW.xz;
  float lit = sunlight(vW, n);
  float ao = vW.y < 0.2 ? texture2D(uAO, (p + uHalf + 1.0) / (2.0 * uHalf + 2.0)).r : 0.0;
  float dark = clamp((1.0 - lit) * 0.55 + ao * 0.5, 0.0, 1.0);

  vec3 col = uPaper; float plate = 0.0;
  // a quiet checker of spot-A screen tint gives the page a grid rhythm you can read at speed
  vec2 tile = floor(p / 4.0);
  float checker = mod(tile.x + tile.y, 2.0);
  col = mix(col, uSpotA, halftone(p, ld, 0.1) * checker * 0.55);
  // shade: spot-B dots, then hatch in the deepest creases
  float tintB = halftone(p + 0.37, ld, smoothstep(0.05, 0.95, dark) * 0.6);
  col = mix(col, uSpotB, tintB); plate = tintB;
  float ink = hatch(p, ld, smoothstep(0.7, 1.0, dark) * 0.35, 1.0);

  // printed page furniture: 4 m grid, crop marks at intersections, 1 m dot grid, margin rule, centre target
  vec2 g4 = abs(fract(p / 4.0 + 0.5) - 0.5) * 4.0;
  float lines = below(min(g4.x, g4.y), 0.02);
  float crop = below(min(g4.x, g4.y), 0.05) * below(max(g4.x, g4.y), 0.5);
  vec2 g1 = abs(fract(p + 0.5) - 0.5);
  float pips = below(max(g1.x, g1.y), 0.045);
  float m = max(abs(p.x), abs(p.y));
  float margin = band(m, uHalf - 1.3, uHalf - 1.05);
  float cl = length(p);
  float rings = max(band(cl, 4.5, 4.62), band(cl, 5.0, 5.05));
  float hair = below(min(abs(p.x), abs(p.y)), 0.04) * band(cl, 3.4, 6.6);
  ink = max(ink, max(max(lines * 0.55, crop), max(pips * 0.7, max(rings, hair))));
  col = mix(col, uSpotA, margin); plate *= 1.0 - margin;

  float f = fogAmt(dist);
  emit(mix(col, uPaper, f), plate * (1.0 - f), ink * (1.0 - 0.8 * f), n);
}
`;

const TYPE_FRAG = LIGHT + /* glsl */`
uniform sampler2D uAtlas;
float inkMask(float v) { float w = clamp(fwidth(v) * 0.8, 0.03, 0.5); return smoothstep(0.5 - w, 0.5 + w, v); }
void main() {
  vec3 n = normalize(vN);
  float dist = length(vW - cameraPosition);
  vec2 p = planar(vW, n);
  float row = vStyle.z;
  vec2 uv = vec2(vUV.x / vDim.x, (row + clamp(1.0 - vUV.y / vDim.y, 0.006, 0.994)) / ${ATLAS_ROWS}.0);
  vec3 m = texture2D(uAtlas, uv).rgb;
  float kPaper = inkMask(m.r), kA = inkMask(m.g), kB = inkMask(m.b);
  float dark = faceDark(n, 0.0);
  float shade = halftone(p, lodDist(vW, n), smoothstep(0.3, 0.9, dark) * 0.4);

  vec3 col; float plate = 0.0, ink;
  if (vStyle.x > 2.5) {          // black poster, type knocked out
    col = mix(mix(uPaper, uSpotA, kA), uSpotB, kB);
    plate = kB;
    ink = max(1.0 - max(kPaper, max(kA, kB)), shade);
  } else {                       // light stock, type printed
    vec3 base = vStyle.x < 0.5 ? uPaper : (vStyle.x < 1.5 ? uSpotA : uSpotB);
    col = mix(mix(base, uSpotA, kA), uSpotB, kB);
    plate = max(kB, vStyle.x > 1.5 ? 1.0 - kA : 0.0);
    ink = max(kPaper, shade);
  }
  float f = fogAmt(dist);
  emit(mix(col, uPaper, f), plate * (1.0 - f), ink * (1.0 - 0.8 * f), n);
}
`;

const PAD_VERT = /* glsl */`
attribute vec2 aUV;
attribute vec4 aPad;     // launch dir xz, kind (0 plate / 1 arrows), phase
varying vec3 vW;
varying vec3 vN;
varying vec2 vUV;
varying vec4 vPad;
void main() {
  vW = position; vN = normal; vUV = aUV; vPad = aPad;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  placeDepth();
}
`;
const PAD_FRAG = /* glsl */`
varying vec3 vW;
varying vec3 vN;
varying vec2 vUV;
varying vec4 vPad;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float t = uTime + vPad.w;
  if (vPad.z > 0.5) {
    // rising chevrons above the pad
    float x = abs(vUV.x);
    float y = vUV.y / 0.75 - t * 1.6 + x * 0.9;
    float fy = fract(y);
    float fade = 1.0 - smoothstep(1.2, 3.0, vUV.y);      // chevrons thin out as they rise
    float chev = step(fy, 0.42 * fade) * step(x, 0.62 * (0.4 + 0.6 * fade));
    if (chev < 0.5) discard;
    vec3 col = mod(floor(y), 2.0) < 0.5 ? uSpotA : uSpotB;
    emit(col, 0.0, 0.0, n);
    return;
  }
  float dist = length(vW - cameraPosition);
  vec3 col = uSpotB; float ink = 0.0;
  if (n.y > 0.5) {
    // deck: chevrons marching toward the launch direction, hazard border
    vec2 dir = length(vPad.xy) > 0.01 ? normalize(vPad.xy) : vec2(0.0, 1.0);
    float along = dot(vUV, dir), across = abs(dot(vUV, vec2(-dir.y, dir.x)));
    float chev = step(0.5, fract((along + across * 0.9) / 0.5 - t * 2.2));
    float m = max(abs(vUV.x), abs(vUV.y));
    float pulse = 0.5 + 0.5 * sin(t * 6.0);
    col = mix(uSpotB, uPaper, chev);
    col = mix(col, uSpotA, band(m, 0.62, 0.74) * (0.6 + 0.4 * pulse));
    ink = max(band(m, 0.74, 10.0), band(m, 0.56, 0.62));
  } else {
    ink = step(0.5, fract((vUV.x + vUV.y) / 0.2));
    col = uSpotA;
  }
  float f = fogAmt(dist);
  emit(mix(col, uPaper, f), 0.0, ink * (1.0 - 0.8 * f), n);
}
`;

const DEPTH_ONLY = new THREE.ShaderMaterial({
  vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
});

// ---------------------------------------------------------------------------------------------
// geometry

class FaceBuffer {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.dim = []; this.style = []; this.idx = []; this.count = 0; }
  // quad from origin o spanning U*w and V*h (cross(U,V) = normal)
  quad(o, U, V, w, h, n, style, uv0 = 0, v0 = 0, fullW = w, fullH = h) {
    const b = this.count;
    for (const [a, c] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      this.pos.push(o[0] + U[0] * w * a + V[0] * h * c, o[1] + U[1] * w * a + V[1] * h * c, o[2] + U[2] * w * a + V[2] * h * c);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uv0 + w * a, v0 + h * c);
      this.dim.push(fullW, fullH);
      this.style.push(style[0], style[1], style[2], style[3]);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.count += 4;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aDim', new THREE.Float32BufferAttribute(this.dim, 2));
    g.setAttribute('aStyle', new THREE.Float32BufferAttribute(this.style, 4));
    g.setIndex(this.idx);
    return g;
  }
}

const SIDES = [
  { n: [1, 0, 0], U: [0, 0, -1] }, { n: [-1, 0, 0], U: [0, 0, 1] },
  { n: [0, 0, 1], U: [1, 0, 0] }, { n: [0, 0, -1], U: [-1, 0, 0] },
];

function sideOrigin(b, s) {
  // left-bottom corner as seen from outside the face
  const x = s.n[0] > 0 ? b.max[0] : s.n[0] < 0 ? b.min[0] : (s.U[0] > 0 ? b.min[0] : b.max[0]);
  const z = s.n[2] > 0 ? b.max[2] : s.n[2] < 0 ? b.min[2] : (s.U[2] > 0 ? b.min[2] : b.max[2]);
  return [x, b.min[1], z];
}

function isSupported(b, boxes) {
  if (b.min[1] <= 0.02) return true;
  for (const o of boxes) {
    if (o === b || Math.abs(o.max[1] - b.min[1]) > 0.06) continue;
    if (o.min[0] < b.max[0] && o.max[0] > b.min[0] && o.min[2] < b.max[2] && o.max[2] > b.min[2]) return true;
  }
  return false;
}

// Big wall faces looking into the arena become typographic "pages" (at most ATLAS_ROWS of them).
function pickTypeWalls(map) {
  const out = [];
  for (const b of map.boxes) {
    if (b.kind !== 'wall' || out.length >= ATLAS_ROWS) continue;
    const top = b.max[1], h = top - Math.max(0, b.min[1]);
    if (h < 5) continue;
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    for (let i = 0; i < 4; i++) {
      const s = SIDES[i];
      const len = s.n[0] !== 0 ? b.max[2] - b.min[2] : b.max[0] - b.min[0];
      if (len < map.size * 0.6) continue;
      if (s.n[0] * -cx + s.n[2] * -cz <= 0) continue;   // must face the arena centre
      out.push({ box: b, side: i, row: out.length });
      break;
    }
  }
  return out;
}

function buildGeometry(map) {
  const floor = new FaceBuffer(), type = new FaceBuffer(), rest = new FaceBuffer();
  const typeWalls = pickTypeWalls(map);
  for (const b of map.boxes) {
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    if (!(w > 0 && h > 0 && d > 0)) continue;
    const kind = KIND[b.kind] ?? KIND_DEFAULT;
    const tone = Math.min(3, Math.max(0, b.tone | 0));
    const style = [tone, kind, b.min[1], kind !== KIND.floor && isSupported(b, map.boxes) ? 1 : 0];
    // top / bottom
    (kind === KIND.floor ? floor : rest).quad([b.min[0], b.max[1], b.max[2]], [1, 0, 0], [0, 0, -1], w, d, [0, 1, 0], style);
    rest.quad([b.min[0], b.min[1], b.min[2]], [1, 0, 0], [0, 0, 1], w, d, [0, -1, 0], style);
    for (let i = 0; i < 4; i++) {
      const s = SIDES[i];
      const len = s.n[0] !== 0 ? d : w;
      const o = sideOrigin(b, s);
      const tw = typeWalls.find((t) => t.box === b && t.side === i);
      if (tw) {
        const y0 = Math.max(0, b.min[1]);
        type.quad([o[0], y0, o[2]], s.U, [0, 1, 0], len, b.max[1] - y0, s.n, [tone, kind, tw.row, 0]);
        if (y0 > b.min[1]) rest.quad(o, s.U, [0, 1, 0], len, y0 - b.min[1], s.n, style);
      } else {
        rest.quad(o, s.U, [0, 1, 0], len, h, s.n, style);
      }
    }
  }
  return { floor: floor.build(), type: type.build(), rest: rest.build() };
}

function buildPads(map) {
  const pos = [], nor = [], uv = [], pad = [], idx = [];
  let count = 0;
  const quad = (pts, n, uvs, pd) => {
    for (let i = 0; i < 4; i++) { pos.push(...pts[i]); nor.push(...n); uv.push(...uvs[i]); pad.push(...pd); }
    idx.push(count, count + 1, count + 2, count, count + 2, count + 3);
    count += 4;
  };
  (map.jumpPads || []).forEach((jp, k) => {
    const cx = (jp.min[0] + jp.max[0]) / 2, cz = (jp.min[2] + jp.max[2]) / 2;
    const hx = (jp.max[0] - jp.min[0]) / 2, hz = (jp.max[2] - jp.min[2]) / 2;
    const y0 = jp.min[1], y1 = jp.min[1] + 0.16;
    const pd = [jp.vel[0], jp.vel[2], 0, k * 0.37];
    // deck (uv normalised to [-1,1] over the pad) and four skirts
    quad([[cx - hx, y1, cz + hz], [cx + hx, y1, cz + hz], [cx + hx, y1, cz - hz], [cx - hx, y1, cz - hz]], [0, 1, 0], [[-1, 1], [1, 1], [1, -1], [-1, -1]], pd);
    for (const s of SIDES) {
      const ux = s.U[0], uz = s.U[2];
      const ox = cx + s.n[0] * hx - ux * hx, oz = cz + s.n[2] * hz - uz * hz;
      const len = 2 * (ux !== 0 ? hx : hz);
      quad([[ox, y0, oz], [ox + ux * len, y0, oz + uz * len], [ox + ux * len, y1, oz + uz * len], [ox, y1, oz]], s.n, [[0, 0], [len, 0], [len, y1 - y0], [0, y1 - y0]], pd);
    }
    // two crossed billboards of rising chevrons
    const pa = [jp.vel[0], jp.vel[2], 1, k * 0.37];
    const r = Math.min(hx, hz) * 0.8, top = y1 + 3.0;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      quad([[cx - dx * r, y1 + 0.1, cz - dz * r], [cx + dx * r, y1 + 0.1, cz + dz * r], [cx + dx * r, top, cz + dz * r], [cx - dx * r, top, cz - dz * r]],
        [dz, 0, -dx], [[-1, 0], [1, 0], [1, 3], [-1, 3]], pa);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPad', new THREE.Float32BufferAttribute(pad, 4));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------------------------
// baked textures

function bakeAO(map, data) {
  const half = map.size / 2 + 1, cell = (2 * half) / AO_N;
  const a = new Float32Array(AO_N * AO_N), t = new Float32Array(AO_N * AO_N);
  for (const b of map.boxes) {
    if (b.kind === 'floor' || b.min[1] > 0.3 || b.max[1] < 0.3) continue;
    const x0 = Math.max(0, Math.floor((b.min[0] + half) / cell)), x1 = Math.min(AO_N - 1, Math.ceil((b.max[0] + half) / cell) - 1);
    const z0 = Math.max(0, Math.floor((b.min[2] + half) / cell)), z1 = Math.min(AO_N - 1, Math.ceil((b.max[2] + half) / cell) - 1);
    const k = Math.min(1, 0.55 + (b.max[1] - b.min[1]) * 0.15);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) a[z * AO_N + x] = Math.max(a[z * AO_N + x], k);
  }
  const R = 4;
  for (let pass = 0; pass < 2; pass++) {
    for (let z = 0; z < AO_N; z++) for (let x = 0; x < AO_N; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += a[z * AO_N + Math.min(AO_N - 1, Math.max(0, x + k))];
      t[z * AO_N + x] = s / (2 * R + 1);
    }
    for (let z = 0; z < AO_N; z++) for (let x = 0; x < AO_N; x++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += t[Math.min(AO_N - 1, Math.max(0, z + k)) * AO_N + x];
      a[z * AO_N + x] = s / (2 * R + 1);
    }
  }
  for (let i = 0; i < a.length; i++) data[i] = Math.min(255, a[i] * 2.1 * 255);
}

// R = knocked-out / printed type, G = spot A, B = spot B. Thresholded in the shader, so edges stay crisp up close.
function drawAtlas(ctx, map, typeWallCount) {
  const W = ATLAS_W, H = ATLAS_ROW;
  const K = '#ff0000', A = '#00ff00', B = '#0000ff';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H * ATLAS_ROWS);
  const seed = map.seed >>> 0;
  const pg = String(2 + (seed % 97)).padStart(2, '0');
  const issue = String(1 + ((seed >>> 3) % 48)).padStart(2, '0');
  const code = (seed * 2654435761 >>> 0).toString(16).toUpperCase().padStart(8, '0');

  const fit = (text, font, size, maxW) => {
    ctx.font = `${size}px ${font}`;
    const w = ctx.measureText(text).width;
    if (w > maxW) { size *= maxW / w; ctx.font = `${size}px ${font}`; }
    return size;
  };
  const big = (text, x, color, maxW, size = 196, base = 190) => {
    const s = fit(text, FONT_DISPLAY, size, maxW);
    ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillText(text, x, base - (size - s) * 0.36);
    return ctx.measureText(text).width;
  };
  const small = (text, x, y, color, px = 15, font = FONT_MONO) => {
    ctx.font = font.replace('%', px); ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  };
  const reg = (x, y, r, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, r * 0.14);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - r * 1.5, y); ctx.lineTo(x + r * 1.5, y); ctx.moveTo(x, y - r * 1.5); ctx.lineTo(x, y + r * 1.5); ctx.stroke();
  };
  const colorBar = (x, y, n, sz) => {
    const cols = [A, B, K, A, K, B];
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = cols[i % cols.length];
      if (i % 4 === 3) { for (let k = 0; k < sz; k += 6) ctx.fillRect(x + i * (sz + 4) + k, y, 3, sz); }
      else ctx.fillRect(x + i * (sz + 4), y, sz, sz);
    }
    return n * (sz + 4);
  };
  const barcode = (x, y, w, h, s) => {
    ctx.fillStyle = K;
    let cx = x, r = s;
    while (cx < x + w) {
      r = (r * 1103515245 + 12345) >>> 0;
      const bw = 3 + ((r >>> 16) % 3) * 3, gap = 3 + ((r >>> 20) % 3) * 2;
      ctx.fillRect(cx, y, Math.min(bw, x + w - cx), h);
      cx += bw + gap;
    }
  };
  const footer = (text, color = K) => {
    ctx.fillStyle = color; ctx.fillRect(24, 201, W - 48, 4);
    // dashed "cut here" rule at head height + repeating imprint
    for (let x = 24; x < W - 48; x += 34) ctx.fillRect(x, 244, 18, 3);
    let x = 40;
    while (x < W - 300) x += small(text, x, 224, color, 17) + 70;
  };
  const header = (xBar, nBar, text) => {
    colorBar(xBar, 10, nBar, 24);
    ctx.fillStyle = K; ctx.fillRect(24, 40, W - 48, 3);
    small(text, xBar > 600 ? 40 : xBar + nBar * 28 + 40, 23, K, 17);
  };

  const pages = [
    () => {
      header(1180, 26, `MISPRINT QUARTERLY — ISSUE ${issue} — ${map.name} — REPRINT ${code}`);
      reg(92, 118, 44, K);
      let x = 190;
      x += big(`PG.${pg}`, x, K, 760) + 70;
      x += big(map.name, x, B, 1500 - x) + 60;
      barcode(1560, 62, 420, 104, seed + 1);
      small(`0 ${code.slice(0, 4)} ${code.slice(4)} ${pg}`, 1562, 182, K, 20);
      footer(`${map.name}  ·  PROOF COPY  ·  DO NOT DISTRIBUTE  ·  PG.${pg}`);
    },
    () => {
      header(40, 18, `REGISTRATION ±2 PT — TRIM — FOLD — STAPLE — SEE ERRATA SLIP — Nº ${issue}`);
      let x = 40;
      x += big('MISPRINT', x, A, 1180) + 60;
      ctx.fillStyle = K; ctx.fillRect(x, 60, 8, 130); x += 40;
      ctx.font = `92px ${FONT_HEAVY}`; ctx.fillStyle = K; ctx.textBaseline = 'alphabetic';
      ctx.fillText('ISSUE', x, 122);
      ctx.fillStyle = B; ctx.fillText(`Nº${issue}`, x, 192);
      reg(1930, 118, 52, K);
      footer(`NOW PRINTING  ·  ${map.name}  ·  TWO SPOT INKS + BLACK  ·  KEEP HANDS CLEAR OF THE DRUM`);
    },
    () => {
      header(720, 30, `${map.name} / SHEET ${pg} OF 99 / ${code}`);
      barcode(40, 62, 300, 104, seed + 7);
      small(`${code}`, 42, 182, K, 20);
      let x = 400;
      x += big(map.name, x, K, 1180) + 60;
      reg(x + 50, 118, 44, A);
      big(`${pg}`, x + 150, B, 2000 - (x + 150));
      footer(`RETURN TO SENDER  ·  ${map.name}  ·  FIRST DRAFT  ·  OUT OF INK  ·  SHEET ${pg}`);
    },
    () => {
      header(1420, 18, `PLATE A / PLATE B / KEY — CHECK REGISTER BEFORE EVERY RUN — ${code}`);
      reg(86, 118, 44, K);
      let x = 180;
      x += big('NOW', x, B, 520) + 40;
      x += big('PRINTING', x, K, 1050) + 60;
      colorBar(x, 66, 3, 56); colorBar(x, 130, 3, 56);
      big('→', x + 210, A, 200);
      footer(`ERRATA  ·  LOSERS REPRINT  ·  ${map.name}  ·  ISSUE ${issue}  ·  STAPLE HERE`);
    },
  ];
  for (let row = 0; row < typeWallCount; row++) {
    ctx.save();
    ctx.translate(0, row * H);
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    pages[(row + (seed & 3)) % pages.length]();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------------------------

export function createWorld(renderer) {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const bakeScene = new THREE.Scene();
  const lightCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  const shadowMat = { value: new THREE.Matrix4() };
  let shadowRT = null;
  const shadowTex = { value: null };
  const makeShadowRT = (size) => {
    const dt = new THREE.DepthTexture(size, size);
    dt.type = THREE.UnsignedIntType;
    dt.compareFunction = THREE.LessEqualCompare;
    dt.minFilter = dt.magFilter = THREE.LinearFilter;
    shadowRT = new THREE.WebGLRenderTarget(size, size, { depthTexture: dt, generateMipmaps: false });
    shadowTex.value = dt;
  };
  makeShadowRT(SHADOW_SIZE[1]);

  const aoData = new Uint8Array(AO_N * AO_N);
  const aoTex = new THREE.DataTexture(aoData, AO_N, AO_N, THREE.RedFormat);
  aoTex.minFilter = aoTex.magFilter = THREE.LinearFilter;
  aoTex.colorSpace = THREE.NoColorSpace;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = ATLAS_ROW * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  atlas.flipY = false;

  const lightUniforms = { uShadow: shadowTex, uShadowMat: shadowMat };
  const uHalf = { value: 28 };
  const mats = {
    rest: inkMaterial({ vertex: VERT, fragment: BOX_FRAG, uniforms: lightUniforms }),
    floor: inkMaterial({ vertex: VERT, fragment: FLOOR_FRAG, uniforms: { ...lightUniforms, uAO: { value: aoTex }, uHalf } }),
    type: inkMaterial({ vertex: VERT, fragment: TYPE_FRAG, uniforms: { ...lightUniforms, uAtlas: { value: atlas } } }),
    pads: inkMaterial({ vertex: PAD_VERT, fragment: PAD_FRAG, side: THREE.DoubleSide }),
  };
  const meshes = [];
  let padMesh = null;

  function clear() {
    for (const m of meshes) { group.remove(m); m.geometry.dispose(); }
    meshes.length = 0;
    padMesh = null;
  }

  function bakeShadows(map) {
    const half = map.size / 2 + 2;
    let top = 10;
    for (const b of map.boxes) top = Math.max(top, b.max[1]);
    const center = new THREE.Vector3(0, top / 2, 0);
    const radius = Math.hypot(half, half, top / 2) + 1;
    lightCam.position.copy(center).addScaledVector(SUN_DIR, radius + 20);
    lightCam.lookAt(center);
    lightCam.left = lightCam.bottom = -radius; lightCam.right = lightCam.top = radius;
    lightCam.near = 1; lightCam.far = 2 * radius + 40;
    lightCam.updateProjectionMatrix();
    lightCam.updateMatrixWorld(true);
    shadowMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(lightCam.projectionMatrix).multiply(lightCam.matrixWorldInverse);

    const parent = group.parent;
    if (padMesh) padMesh.visible = false;   // pads and their arrows must not cast
    bakeScene.add(group);
    bakeScene.overrideMaterial = DEPTH_ONLY;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(shadowRT);
    renderer.clear();
    renderer.render(bakeScene, lightCam);
    renderer.setRenderTarget(prev);
    bakeScene.overrideMaterial = null;
    if (padMesh) padMesh.visible = true;
    if (parent) parent.add(group); else bakeScene.remove(group);
  }

  return {
    group,
    build(map) {
      clear();
      const geo = buildGeometry(map);
      for (const key of ['rest', 'floor', 'type']) {
        if (!geo[key].index.count) { geo[key].dispose(); continue; }
        const mesh = new THREE.Mesh(geo[key], mats[key]);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        group.add(mesh);
        meshes.push(mesh);
      }
      const pads = buildPads(map);
      if (pads.index.count) {
        padMesh = new THREE.Mesh(pads, mats.pads);
        padMesh.matrixAutoUpdate = false;
        padMesh.frustumCulled = false;
        group.add(padMesh);
        meshes.push(padMesh);
      } else pads.dispose();
      bakeShadows(map);

      uHalf.value = map.size / 2;
      bakeAO(map, aoData);
      aoTex.needsUpdate = true;
      drawAtlas(ctx, map, Math.min(ATLAS_ROWS, pickTypeWalls(map).length));
      atlas.needsUpdate = true;
    },
    setQuality(q) {
      const size = SHADOW_SIZE[q] ?? SHADOW_SIZE[1];
      if (shadowRT.width === size) return false;
      shadowRT.depthTexture.dispose();
      shadowRT.dispose();
      makeShadowRT(size);
      return true;   // caller rebuilds the bake
    },
    rebake(map) { bakeShadows(map); },
    dispose() {
      clear();
      for (const k in mats) mats[k].dispose();
      shadowRT.depthTexture.dispose(); shadowRT.dispose(); aoTex.dispose(); atlas.dispose();
    },
  };
}
