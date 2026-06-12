// Minimal deterministic 3D math for the sim core. No three.js imports here:
// the sim must run identically in the browser and in the Node server.

export interface Vec3 { x: number; y: number; z: number; }
export interface Quat { x: number; y: number; z: number; w: number; }

export function v3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; }
export function vclone(a: Vec3): Vec3 { return { x: a.x, y: a.y, z: a.z }; }
export function vset(out: Vec3, a: Vec3): Vec3 { out.x = a.x; out.y = a.y; out.z = a.z; return out; }
export function vadd(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vsub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vscale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function vaddInPlace(a: Vec3, b: Vec3): void { a.x += b.x; a.y += b.y; a.z += b.z; }
export function vdot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vcross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function vlen(a: Vec3): number { return Math.hypot(a.x, a.y, a.z); }
export function vlen2(a: Vec3): number { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function vdist(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function vdist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  return l > 1e-12 ? vscale(a, 1 / l) : v3(0, 0, 1);
}
export function vlerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function qident(): Quat { return { x: 0, y: 0, z: 0, w: 1 }; }
export function qclone(q: Quat): Quat { return { x: q.x, y: q.y, z: q.z, w: q.w }; }
export function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}
export function qaxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2, s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}
// Rotate vector by quaternion.
export function qrot(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
// Integrate body-frame angular velocity (rad/s) into orientation over dt.
export function qIntegrate(q: Quat, angVel: Vec3, dt: number): Quat {
  const hx = angVel.x * dt / 2, hy = angVel.y * dt / 2, hz = angVel.z * dt / 2;
  const dq: Quat = { x: hx, y: hy, z: hz, w: 1 };
  return qnorm(qmul(q, dq));
}
// Forward (-Z), up (+Y) and right (+X) of an orientation, matching three.js camera convention.
export function qForward(q: Quat): Vec3 { return qrot(q, v3(0, 0, -1)); }
export function qUp(q: Quat): Vec3 { return qrot(q, v3(0, 1, 0)); }
export function qRight(q: Quat): Vec3 { return qrot(q, v3(1, 0, 0)); }

// Quaternion that rotates the -Z axis onto dir (with a stable up reference).
export function qLookAt(dir: Vec3, up: Vec3 = v3(0, 1, 0)): Quat {
  const f = vnorm(dir);
  let r = vcross(f, vscale(up, -1));
  if (vlen2(r) < 1e-9) r = vcross(f, v3(0, 0, 1));
  r = vnorm(vscale(r, -1));
  const u = vcross(r, f);
  // Build quaternion from basis (right, up, -forward as +Z back)
  const m00 = r.x, m01 = u.x, m02 = -f.x;
  const m10 = r.y, m11 = u.y, m12 = -f.y;
  const m20 = r.z, m21 = u.z, m22 = -f.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
  }
  return qnorm(q);
}

export function qnlerp(a: Quat, b: Quat, t: number): Quat {
  // take shortest path
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  return qnorm({
    x: a.x + (b.x * s - a.x) * t,
    y: a.y + (b.y * s - a.y) * t,
    z: a.z + (b.z * s - a.z) * t,
    w: a.w + (b.w * s - a.w) * t,
  });
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// Where to aim so a projectile of speed `projSpeed` (relative to the shooter)
// intercepts a moving target. Two fixed-point iterations are plenty at game
// speeds. Shared by pirate AI, the HUD lead pip and test bots.
export function leadPoint(shooterPos: Vec3, shooterVel: Vec3, targetPos: Vec3, targetVel: Vec3, projSpeed: number): Vec3 {
  const relVel = vsub(targetVel, shooterVel);
  let t = vdist(shooterPos, targetPos) / projSpeed;
  let aim = vadd(targetPos, vscale(relVel, t));
  t = vdist(shooterPos, aim) / projSpeed;
  aim = vadd(targetPos, vscale(relVel, t));
  return aim;
}
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
// Angle in radians between two direction vectors.
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(vdot(vnorm(a), vnorm(b)), -1, 1));
}
