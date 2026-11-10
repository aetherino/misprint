// Tiny procedural modelling kit. Every character, weapon and pickup is assembled from primitives into
// ONE merged geometry whose vertices carry a part index (animated by a matrix palette in the shader)
// and a palette index (which ink the surface is printed with).
import * as THREE from 'three';

export const PAL = { INK: 0, PAPER: 1, DARK: 2, SCREEN: 3, ACCENT: 4, METAL: 5, GLOW: 6, SPOT: 7 };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Matrix3();

export class RigBuilder {
  constructor() { this.pos = []; this.nor = []; this.out = []; this.part = []; this.pal = []; this.uv = []; this.idx = []; this.count = 0; }

  /** Append `geom` (consumed + disposed). o: { p, r (euler XYZ), s, part, pal } */
  add(geom, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1], part = 0, pal = 0 } = {}) {
    _m.compose(_p.fromArray(p), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.fromArray(s));
    _n.getNormalMatrix(_m);
    geom.computeBoundingBox();
    const bb = geom.boundingBox, c = bb.getCenter(new THREE.Vector3()), h = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const P = geom.attributes.position, N = geom.attributes.normal, U = geom.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i);
      // hull direction: toward the corner/rim of the primitive, so inverted-hull rims stay closed at hard edges
      const ox = (_v.x - c.x) / (h.x || 1), oy = (_v.y - c.y) / (h.y || 1), oz = (_v.z - c.z) / (h.z || 1);
      _v.applyMatrix4(_m);
      this.pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize();
      this.nor.push(_v.x, _v.y, _v.z);
      _v.set(ox, oy, oz).applyMatrix3(_n).normalize();
      this.out.push(_v.x, _v.y, _v.z);
      this.part.push(part);
      this.pal.push(pal);
      if (U) this.uv.push(U.getX(i), U.getY(i)); else this.uv.push(0, 0);
    }
    const I = geom.index;
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(this.count + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(this.count + i);
    this.count += P.count;
    geom.dispose();
    return this;
  }

  /** Box; taper = [tx, tz] scales the top face (trapezoid bodies), shear = z offset of the top face. */
  box(w, h, d, o = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (o.taper || o.shear) {
      const P = g.attributes.position, [tx, tz] = o.taper || [1, 1];
      for (let i = 0; i < P.count; i++) if (P.getY(i) > 0) P.setXYZ(i, P.getX(i) * tx, P.getY(i), P.getZ(i) * tz + (o.shear || 0));
      g.computeVertexNormals();
    }
    return this.add(g, o);
  }
  /** Cylinder along Y (rotate with o.r); rTop/rBot radii. */
  cyl(rTop, rBot, h, o = {}) { return this.add(new THREE.CylinderGeometry(rTop, rBot, h, o.seg || 12), o); }
  ball(r, o = {}) { return this.add(new THREE.SphereGeometry(r, o.seg || 12, Math.max(6, (o.seg || 12) * 0.66 | 0)), o); }
  torus(R, r, o = {}) { return this.add(new THREE.TorusGeometry(R, r, 8, o.seg || 20), o); }
  /** Flat quad facing +Z with uv 0..1 (rotate with o.r). */
  plane(w, h, o = {}) { return this.add(new THREE.PlaneGeometry(w, h), o); }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aOut', new THREE.Float32BufferAttribute(this.out, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPal', new THREE.Float32BufferAttribute(this.pal, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/** Writes T * Rzyx * S into a mat4 palette slot without allocating. */
export function setPart(arr, slot, px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _m.compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
  _m.toArray(arr, slot * 16);
}
/** slot = parent * (T * R * S) — for things carried by another part (weapon in hand). */
const _a = new THREE.Matrix4();
export function setChildPart(arr, slot, parent, px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _a.fromArray(arr, parent * 16);
  _m.compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
  _a.multiply(_m).toArray(arr, slot * 16);
}
export function hidePart(arr, slot) { arr.fill(0, slot * 16, slot * 16 + 16); }
