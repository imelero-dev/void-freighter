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
  massFactor?: number; // inertia multiplier; heavier hulls ramp/settle slower
  vtol?: boolean;      // hover mode: snap-to-stop damping + crisp vertical/lateral
}

export function integrateFlight(b: FlightBody, input: ShipInput, perf: FlightPerf, dt: number, assist: boolean): void {
  // speed-dependent handling: nimble at low speed (dogfights), heavy at full
  // burn — turn authority drops from 125% at standstill to 80% at max speed
  const speedFrac = Math.min(1, vlen(b.vel) / Math.max(1, perf.maxSpeed));
  const turnRate = perf.turnRate * (1.25 - 0.45 * speedFrac);
  // rotational inertia: a heavy freighter is slow to start AND stop turning;
  // a light scout snaps. This is what makes mass perceptible at the stick.
  const mass = perf.massFactor ?? 1;
  const angAccel = (turnRate * 10) / Math.sqrt(mass);
  const pitch = clamp(input.pitch, -1, 1);
  const yaw = clamp(input.yaw, -1, 1);
  const roll = clamp(input.roll, -1, 1);
  if (assist) {
    // FA on: active gyros drive angular velocity toward the commanded rate, so
    // releasing the stick bleeds the spin back to zero
    const targetAng = v3(pitch * turnRate, yaw * turnRate, roll * turnRate);
    b.angVel.x += clamp(targetAng.x - b.angVel.x, -angAccel * dt, angAccel * dt);
    b.angVel.y += clamp(targetAng.y - b.angVel.y, -angAccel * dt, angAccel * dt);
    b.angVel.z += clamp(targetAng.z - b.angVel.z, -angAccel * dt, angAccel * dt);
  } else {
    // FA off: pure Newtonian rotation — input applies torque (adds angular
    // momentum), nothing damps it. To stop spinning you counter-rotate. A spin
    // cap keeps a twitchy stick from winding up to nonsense rates.
    b.angVel.x += pitch * angAccel * dt;
    b.angVel.y += yaw * angAccel * dt;
    b.angVel.z += roll * angAccel * dt;
    // cap off the BASE turn rate, not the speed-adjusted one — otherwise
    // accelerating would retroactively clamp an existing spin, which is exactly
    // the damping FA-off promises never happens
    const maxSpin = perf.turnRate * 1.8;
    b.angVel.x = clamp(b.angVel.x, -maxSpin, maxSpin);
    b.angVel.y = clamp(b.angVel.y, -maxSpin, maxSpin);
    b.angVel.z = clamp(b.angVel.z, -maxSpin, maxSpin);
  }
  b.orient = qIntegrate(b.orient, b.angVel, dt);

  b.throttle = clamp(input.thrustForward, -0.3, 1);
  if (assist && !input.brake) {
    // VTOL gives crisp vertical/lateral authority for precise hovering
    const lat = perf.vtol ? 1.0 : 0.85;
    const desiredLocal = v3(
      clamp(input.thrustRight, -1, 1) * lat,
      clamp(input.thrustUp, -1, 1) * lat,
      -b.throttle,
    );
    const desired = vscale(qrot(b.orient, desiredLocal), perf.maxSpeed);
    const delta = vsub(desired, b.vel);
    const dl = vlen(delta);
    // assist corrects the velocity vector much faster than raw thrust — a
    // futuristic ship should feel planted, not like a barge. VTOL hovers hard:
    // it snaps to a dead stop when you release, so you hang in place.
    const maxDelta = perf.accel * (perf.vtol ? 4.5 : 1.6) * dt;
    if (dl > 1e-6) {
      const f = Math.min(1, maxDelta / dl);
      b.vel.x += delta.x * f;
      b.vel.y += delta.y * f;
      b.vel.z += delta.z * f;
    }
    // overspeed bleed: past the cap (turbo release, cruise drop) excess
    // velocity decays fast instead of taking half a minute to settle
    const sp = vlen(b.vel);
    if (sp > perf.maxSpeed * 1.02) {
      const excess = sp - perf.maxSpeed;
      const bleed = Math.min(excess, excess * 1.6 * dt + perf.accel * dt);
      const f = (sp - bleed) / sp;
      b.vel.x *= f;
      b.vel.y *= f;
      b.vel.z *= f;
    }
  } else if (input.brake) {
    // braking power scales with speed: dumping 1 km/s of turbo takes ~2.5 s,
    // not twenty
    const dl = vlen(b.vel);
    if (dl > 1e-6) {
      const dec = Math.min(dl, (perf.accel * 2 + dl * 1.1) * dt);
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
