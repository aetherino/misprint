// Sky: a sheet of theme.sky stock with a giant halftone sun, drifting cut-paper clouds and
// oversized registration marks. Everything is laid out in view-DIRECTION space, so it is
// anchored to the world and never crawls when the camera turns.
import * as THREE from 'three';
import { inkMaterial, SUN_DIR } from './common.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position.z = gl_Position.w;   // pinned to the far plane
}
`;

const FRAG = /* glsl */`
uniform vec3 uSunSky;
uniform float uFovLod;
varying vec3 vDir;

float skyDots(vec2 p, float period, float cov) {
  vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p / period;
  float r = sqrt(clamp(cov, 0.0, 1.0) * 0.5);
  float aa = uFovLod / period;
  return 1.0 - smoothstep(r - aa, r + aa, length(fract(q) - 0.5));
}
float pill(vec2 p, float w, float h) { return length(vec2(max(abs(p.x) - w, 0.0), p.y)) - h; }

// registration target: ring + crosshair, returns line-ink coverage
float regMark(vec3 d, vec3 c, float R, float spin) {
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), c));
  vec3 up = cross(c, right);
  vec2 t = vec2(dot(d, right), dot(d, up));
  if (dot(d, c) < 0.5) return 0.0;
  float cs = cos(spin), sn = sin(spin);
  t = mat2(cs, sn, -sn, cs) * t;
  float w = R * 0.045, aa = uFovLod * 1.5;
  float l = length(t);
  float ring = 1.0 - smoothstep(w, w + aa, abs(l - R));
  float ring2 = 1.0 - smoothstep(w * 0.6, w * 0.6 + aa, abs(l - R * 0.55));
  float hair = (1.0 - smoothstep(w, w + aa, min(abs(t.x), abs(t.y)))) * step(max(abs(t.x), abs(t.y)), R * 1.5);
  return max(max(ring, ring2), hair);
}

void main() {
  vec3 d = normalize(vDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.x, d.z);
  vec2 sp = vec2(az, el);

  vec3 col = uSky;
  float plate = 0.0, ink = 0.0;

  // printed gradient: spot-A dots swelling toward the horizon
  float grad = 1.0 - smoothstep(-0.02, 0.5, el);
  float gd = skyDots(sp, 0.02, grad * grad * 0.5);
  col = mix(col, mix(uSky, uSpotA, 0.6), gd * step(-0.05, el));

  // the sun: solid spot-B disc with a halftone corona
  float sa = acos(clamp(dot(d, uSunSky), -1.0, 1.0));
  vec3 sr = normalize(cross(vec3(0.0, 1.0, 0.0), uSunSky));
  vec2 st = vec2(dot(d, sr), dot(d, cross(uSunSky, sr)));
  float corona = skyDots(st, 0.026, smoothstep(0.55, 0.2, sa) * 0.9);
  float disc = 1.0 - smoothstep(0.2, 0.2 + uFovLod, sa);
  float sun = max(disc, corona * step(sa, 0.7));
  col = mix(col, uSpotB, sun);
  plate = max(plate, sun);
  ink = max(ink, (1.0 - smoothstep(0.006, 0.006 + uFovLod, abs(sa - 0.2))) * 0.9);

  // cut-paper clouds: paper pills with a hard offset shadow and an ink keyline
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float caz = fi * 1.047 + hash11(fi + 3.0) * 0.8 + uTime * (0.006 + 0.004 * hash11(fi + 9.0));
    float cel = 0.42 + 0.4 * hash11(fi * 7.0 + 1.0);
    float w = 0.09 + 0.1 * hash11(fi + 21.0);
    vec2 q = vec2(mod(az - caz + 3.14159, 6.28318) - 3.14159, el - cel);
    q.x *= cos(cel);
    float sd = min(pill(q, w, 0.03), pill(q - vec2(w * 0.3, 0.036), w * 0.5, 0.026));
    float sh = min(pill(q - vec2(0.016, -0.02), w, 0.03), pill(q - vec2(w * 0.3 + 0.016, 0.016), w * 0.5, 0.026));
    float aa = uFovLod;
    float shadow = 1.0 - smoothstep(0.0, aa, sh);
    float body = 1.0 - smoothstep(0.0, aa, sd);
    col = mix(col, uSpotA, shadow * (1.0 - body));
    ink *= 1.0 - max(shadow, body);
    plate *= 1.0 - max(shadow, body);
    col = mix(col, uPaper, body);
    ink = max(ink, 1.0 - smoothstep(0.0025, 0.0025 + aa, abs(sd)));
  }

  // oversized registration marks, slowly turning
  float marks = regMark(d, normalize(vec3(-0.75, 0.5, 0.42)), 0.11, uTime * 0.05);
  marks = max(marks, regMark(d, normalize(vec3(0.2, 0.62, -0.75)), 0.07, -uTime * 0.07));
  marks = max(marks, regMark(d, normalize(vec3(0.7, 0.28, -0.6)), 0.045, uTime * 0.04));
  ink = max(ink, marks * 0.9);

  // below the horizon: the bare sheet, ruled
  float under = 1.0 - smoothstep(-0.06, -0.02, el);
  col = mix(col, mix(uPaper, uSky, 0.35), under);
  float rule = (1.0 - smoothstep(0.1, 0.1 + uFovLod * 20.0, abs(fract(el * 14.0) - 0.5) * 2.0)) * under;
  ink = mix(ink, rule * 0.5, under);
  plate *= 1.0 - under;

  emit(col, plate, ink, vec3(0.0));
}
`;

export function createSky() {
  const sunSky = new THREE.Vector3(SUN_DIR.x, 0.42, SUN_DIR.z).normalize();
  const material = inkMaterial({
    vertex: VERT, fragment: FRAG,
    uniforms: { uSunSky: { value: sunSky }, uFovLod: { value: 0.002 } },
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return {
    mesh,
    /** radians per output pixel, for antialiasing the direction-space shapes */
    update(camera, outH) {
      material.uniforms.uFovLod.value = 2 * Math.tan(camera.fov * Math.PI / 360) / outH;
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}
