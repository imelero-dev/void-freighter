// Shared ship flight integrator: used by the authoritative Sim and by the
// online client for own-ship prediction. Pure math, no state of its own.
//
// Simulator model (#15): ships are masses with linear + angular momentum.
// Orientation and velocity are decoupled — point one way, drift another.
//  - Flight Assist ON: the stick commands turn RATE and the throttle commands
//    a target velocity vector; the assist works the real thrusters (bounded
//    by accel/turnRate and scaled down by mass) to get there. It damps
//    unwanted drift and rotation but cannot cheat physics: a heavy freighter
//    at speed still swings wide through a turn.
//  - Flight Assist OFF: pure Newtonian control. Stick inputs are torque,
//    throttle/strafe are thrust; nothing is ever cancelled for you. Momentum
//    persists until you burn it off yourself (brake is a manual retro burn).

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
  // relative inertia (1 = shuttle). Scales how fast rotation spools up and
  // how much authority the assist has — heavy hulls answer the helm late.
  mass?: number;
}

// FA-off ships keep whatever momentum you give them, but the airframe (and
// the pilot's stomach) impose structural ceilings.
const FA_OFF_SPEED_CAP = 2.0;   // × maxSpeed
const FA_OFF_SPIN_CAP = 2.2;    // × turnRate per axis

export function integrateFlight(b: FlightBody, input: ShipInput, perf: FlightPerf, dt: number, assist: boolean): void {
  const mass = Math.max(0.3, perf.mass ?? 1);

  // ---- rotation ----
  if (assist) {
    // rate control: stick commands angular velocity; FA torques toward it and
    // bleeds residual spin back to zero when the stick is released.
    // speed-dependent authority: nimble at low speed, heavy at full burn.
    const speedFrac = Math.min(1, vlen(b.vel) / Math.max(1, perf.maxSpeed));
    const authority = perf.turnRate * (1.25 - 0.45 * speedFrac);
    const targetAng = v3(
      clamp(input.pitch, -1, 1) * authority,
      clamp(input.yaw, -1, 1) * authority,
      clamp(input.roll, -1, 1) * authority,
    );
    const angAccel = (perf.turnRate * 7) / mass;
    b.angVel.x += clamp(targetAng.x - b.angVel.x, -angAccel * dt, angAccel * dt);
    b.angVel.y += clamp(targetAng.y - b.angVel.y, -angAccel * dt, angAccel * dt);
    b.angVel.z += clamp(targetAng.z - b.angVel.z, -angAccel * dt, angAccel * dt);
  } else {
    // FA off: inputs are raw torque. Angular momentum persists — every spin
    // you start, you stop yourself with counter-stick.
    const angAccel = (perf.turnRate * 2.4) / mass;
    const spinCap = perf.turnRate * FA_OFF_SPIN_CAP;
    b.angVel.x = clamp(b.angVel.x + clamp(input.pitch, -1, 1) * angAccel * dt, -spinCap, spinCap);
    b.angVel.y = clamp(b.angVel.y + clamp(input.yaw, -1, 1) * angAccel * dt, -spinCap, spinCap);
    b.angVel.z = clamp(b.angVel.z + clamp(input.roll, -1, 1) * angAccel * dt, -spinCap, spinCap);
  }
  b.orient = qIntegrate(b.orient, b.angVel, dt);

  b.throttle = clamp(input.thrustForward, -0.3, 1);

  // ---- translation ----
  if (input.brake) {
    // manual retro burn: kills velocity in both assist modes (it is an input,
    // not an autopilot)
    const dl = vlen(b.vel);
    if (dl > 1e-6) {
      const dec = Math.min(dl, perf.accel * 1.2 * dt);
      const f = -dec / dl;
      b.vel.x += b.vel.x * f;
      b.vel.y += b.vel.y * f;
      b.vel.z += b.vel.z * f;
    }
  } else if (assist) {
    // FA drives velocity toward the commanded vector using ONLY real thruster
    // authority (perf.accel, derated by mass) — inertia stays perceptible.
    const desiredLocal = v3(
      clamp(input.thrustRight, -1, 1) * 0.6,
      clamp(input.thrustUp, -1, 1) * 0.6,
      -b.throttle,
    );
    const desired = vscale(qrot(b.orient, desiredLocal), perf.maxSpeed);
    const delta = vsub(desired, b.vel);
    const dl = vlen(delta);
    // RCS correction authority lags on heavy hulls: same main-drive accel,
    // but a fatter ship takes visibly longer to swing its velocity vector
    const maxDelta = perf.accel * (1.15 / Math.sqrt(mass)) * dt;
    if (dl > 1e-6) {
      const f = Math.min(1, maxDelta / dl);
      b.vel.x += delta.x * f;
      b.vel.y += delta.y * f;
      b.vel.z += delta.z * f;
    }
  } else {
    // FA off: thrust adds momentum, nothing cancels it. Drift is forever.
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
    const cap = perf.maxSpeed * FA_OFF_SPEED_CAP;
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
