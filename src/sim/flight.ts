// Shared ship flight integrator: used by the authoritative Sim and by the
// online client for own-ship prediction. Pure math, no state of its own.

import type { ShipInput } from './types';
import { clamp, qIntegrate, qrot, v3, vlen, vscale, vsub, type Quat, type Vec3 } from './vec';

export interface FlightBody {
  pos: Vec3;
  vel: Vec3;
  orient: Quat;
  angVel: Vec3;
  throttle: number;
}

export interface FlightPerf {
  maxSpeed: number;
  accel: number;
  turnRate: number;
}

export function integrateFlight(b: FlightBody, input: ShipInput, perf: FlightPerf, dt: number, assist: boolean): void {
  // speed-dependent handling: nimble at low speed (dogfights), heavy at full
  // burn — turn authority drops from 125% at standstill to 80% at max speed
  const speedFrac = Math.min(1, vlen(b.vel) / Math.max(1, perf.maxSpeed));
  const turnRate = perf.turnRate * (1.25 - 0.45 * speedFrac);
  // rotation: approach commanded angular velocity
  const targetAng = v3(
    clamp(input.pitch, -1, 1) * turnRate,
    clamp(input.yaw, -1, 1) * turnRate,
    clamp(input.roll, -1, 1) * turnRate,
  );
  const angAccel = turnRate * 10; // snappy rotation onset
  b.angVel.x += clamp(targetAng.x - b.angVel.x, -angAccel * dt, angAccel * dt);
  b.angVel.y += clamp(targetAng.y - b.angVel.y, -angAccel * dt, angAccel * dt);
  b.angVel.z += clamp(targetAng.z - b.angVel.z, -angAccel * dt, angAccel * dt);
  b.orient = qIntegrate(b.orient, b.angVel, dt);

  b.throttle = clamp(input.thrustForward, -0.3, 1);
  if (assist && !input.brake) {
    const desiredLocal = v3(
      clamp(input.thrustRight, -1, 1) * 0.6,
      clamp(input.thrustUp, -1, 1) * 0.6,
      -b.throttle,
    );
    const desired = vscale(qrot(b.orient, desiredLocal), perf.maxSpeed);
    const delta = vsub(desired, b.vel);
    const dl = vlen(delta);
    // assist corrects the velocity vector faster than raw thrust accelerates —
    // turns feel planted instead of floaty
    const maxDelta = perf.accel * 1.35 * dt;
    if (dl > 1e-6) {
      const f = Math.min(1, maxDelta / dl);
      b.vel.x += delta.x * f;
      b.vel.y += delta.y * f;
      b.vel.z += delta.z * f;
    }
  } else if (input.brake) {
    const dl = vlen(b.vel);
    if (dl > 1e-6) {
      const dec = Math.min(dl, perf.accel * 1.2 * dt);
      const f = -dec / dl;
      b.vel.x += b.vel.x * f;
      b.vel.y += b.vel.y * f;
      b.vel.z += b.vel.z * f;
    }
  } else {
    const thrustLocal = v3(
      clamp(input.thrustRight, -1, 1),
      clamp(input.thrustUp, -1, 1),
      -clamp(input.thrustForward, -1, 1),
    );
    const acc = vscale(qrot(b.orient, thrustLocal), perf.accel * dt);
    b.vel.x += acc.x;
    b.vel.y += acc.y;
    b.vel.z += acc.z;
    const sp = vlen(b.vel);
    const cap = perf.maxSpeed * 1.6;
    if (sp > cap) {
      const f = cap / sp;
      b.vel.x *= f;
      b.vel.y *= f;
      b.vel.z *= f;
    }
  }
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.pos.z += b.vel.z * dt;
}
