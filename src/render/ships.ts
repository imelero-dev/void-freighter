// Procedural low-poly ship meshes per hull class, pirates included.
// Forward is -Z. Thruster cones glow with throttle.

import * as THREE from 'three';
import type { Entity, HullId, PirateTier } from '../sim/types';

const HULL_GRAY = 0x6b6f73;
const HULL_DARK = 0x44474a;
const RUST = 0x7a4a30;

function mat(color: number, rough = 0.8, metal = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true });
}

export interface ShipView {
  group: THREE.Group;
  thrusters: THREE.Mesh[];
  kind: string;
}

function thruster(size: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(size, size * 2.6, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2; // cone points +Z (backwards)
  return m;
}

function buildShuttle(): ShipView {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.4, 8.5), mat(HULL_GRAY));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.7, 3.2, 4), mat(HULL_DARK));
  nose.rotation.x = -Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  nose.position.z = -5.5;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 2.2), mat(0x222a30, 0.3, 0.9));
  cabin.position.set(0, 1.4, -2.2);
  const engL = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 3.6, 6), mat(RUST));
  engL.rotation.x = Math.PI / 2;
  engL.position.set(-2.4, -0.2, 2.6);
  const engR = engL.clone();
  engR.position.x = 2.4;
  const tL = thruster(0.8);
  tL.position.set(-2.4, -0.2, 4.8);
  const tR = thruster(0.8);
  tR.position.set(2.4, -0.2, 4.8);
  g.add(body, nose, cabin, engL, engR, tL, tR);
  return { group: g, thrusters: [tL, tR], kind: 'shuttle' };
}

function buildHauler(): ShipView {
  const g = new THREE.Group();
  const spine = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 18), mat(HULL_DARK));
  const cab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.6, 4), mat(HULL_GRAY));
  cab.position.z = -10;
  const window = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1, 0.4), mat(0x223038, 0.3, 0.9));
  window.position.set(0, 0.8, -12);
  for (let i = 0; i < 3; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(5.4, 4.2, 4.6), mat(i % 2 ? 0x5a4f3a : 0x4a5560, 0.95, 0.3));
    box.position.z = -3.5 + i * 5.4;
    box.position.y = 0.5;
    g.add(box);
  }
  const eng = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 3), mat(RUST));
  eng.position.z = 10;
  const t1 = thruster(1.1);
  t1.position.set(-1.4, 0, 12.2);
  const t2 = thruster(1.1);
  t2.position.set(1.4, 0, 12.2);
  g.add(spine, cab, window, eng, t1, t2);
  return { group: g, thrusters: [t1, t2], kind: 'hauler' };
}

function buildProspector(): ShipView {
  const g = new THREE.Group();
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 7, 8), mat(HULL_GRAY));
  pod.rotation.x = Math.PI / 2;
  const cab = new THREE.Mesh(new THREE.SphereGeometry(1.9, 10, 8), mat(0x2a3238, 0.4, 0.8));
  cab.position.z = -4.2;
  // drill arms
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 6.5), mat(HULL_DARK));
    arm.position.set(side * 3.1, -0.6, -2.5);
    const drill = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.6, 6), mat(0x8a7a3a, 0.5, 0.8));
    drill.rotation.x = -Math.PI / 2;
    drill.position.set(side * 3.1, -0.6, -6.6);
    g.add(arm, drill);
  }
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 4, 8), mat(RUST));
  tank.rotation.z = Math.PI / 2;
  tank.position.set(0, 2.4, 1);
  const t1 = thruster(1.0);
  t1.position.set(0, 0, 4.8);
  g.add(pod, cab, tank, t1);
  return { group: g, thrusters: [t1], kind: 'prospector' };
}

function buildInterceptor(): ShipView {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.8, 11, 5), mat(HULL_GRAY));
  body.rotation.x = -Math.PI / 2;
  const cab = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), mat(0x202c34, 0.3, 0.9));
  cab.position.set(0, 0.9, -1);
  for (const side of [-1, 1]) {
    const wingShape = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.3, 3.4), mat(HULL_DARK));
    wingShape.position.set(side * 3.6, 0, 1.8);
    wingShape.rotation.z = side * 0.12;
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.4, 6), mat(0x303336, 0.4, 0.9));
    gun.rotation.x = Math.PI / 2;
    gun.position.set(side * 5.6, -0.2, -0.6);
    g.add(wingShape, gun);
  }
  const t1 = thruster(1.0);
  t1.position.set(0, 0, 5.9);
  g.add(body, cab, t1);
  return { group: g, thrusters: [t1], kind: 'interceptor' };
}

function buildFreighter(): ShipView {
  const g = new THREE.Group();
  const spine = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 34), mat(HULL_DARK));
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 5), mat(HULL_GRAY));
  bridge.position.set(0, 1.5, -17);
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(5.5, 6.5, 6.5), mat(i % 2 ? 0x55492f : 0x3f4c58, 0.95, 0.25));
      rack.position.set(side * 5.4, 0, -9 + i * 6.9);
      g.add(rack);
    }
  }
  const eng = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 5), mat(RUST));
  eng.position.z = 19;
  const ts: THREE.Mesh[] = [];
  for (const x of [-2.8, 0, 2.8]) {
    const t = thruster(1.5);
    t.position.set(x, 0, 22.5);
    ts.push(t);
    g.add(t);
  }
  g.add(spine, bridge, eng);
  return { group: g, thrusters: ts, kind: 'freighter' };
}

function buildCorvette(): ShipView {
  const g = new THREE.Group();
  const rust = mat(0x5a4438, 0.95, 0.4);
  const dark = mat(0x3a3632, 0.9, 0.5);
  // long armored hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(26, 14, 96), dark);
  const prow = new THREE.Mesh(new THREE.ConeGeometry(10, 22, 4), rust);
  prow.rotation.x = -Math.PI / 2;
  prow.rotation.y = Math.PI / 4;
  prow.position.z = -58;
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 16), rust);
  bridge.position.set(0, 11, -20);
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 60, 6), rust);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * 17, 0, 8);
    g.add(pod);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(16, 2, 22), dark);
    fin.position.set(side * 22, -4, 30);
    g.add(fin);
  }
  const ts: THREE.Mesh[] = [];
  for (const x of [-8, 0, 8]) {
    const t = thruster(3);
    t.position.set(x, 0, 52);
    ts.push(t);
    g.add(t);
  }
  g.add(hull, prow, bridge);
  return { group: g, thrusters: ts, kind: 'pirate_corvette' };
}

function buildTurret(): ShipView {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4, 2.6, 8), mat(0x4a443c, 0.9, 0.5));
  const head = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 4.4), mat(0x6e3326, 0.85, 0.5));
  head.position.y = 2.4;
  for (const side of [-1, 1]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 6.5, 6), mat(0x303336, 0.5, 0.8));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(side * 1.1, 2.4, -4);
    g.add(barrel);
  }
  g.add(base, head);
  return { group: g, thrusters: [], kind: 'pirate_turret' };
}

function buildPirate(tier: PirateTier): ShipView {
  if (tier === 'corvette') return buildCorvette();
  if (tier === 'turret') return buildTurret();
  const scale = tier === 'elite' ? 1.7 : tier === 'raider' ? 1.35 : tier === 'fighter' ? 1.1 : 0.9;
  const g = new THREE.Group();
  const accent = tier === 'elite' ? 0x8a2a2a : 0x6e3326;
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7.5, 4), mat(0x4a443c, 0.9, 0.5));
  body.rotation.x = -Math.PI / 2;
  body.rotation.z = Math.PI / 4;
  // jagged asymmetric wings
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.35, 2.6), mat(accent, 0.9, 0.4));
  wingL.position.set(-2.6, 0.3, 1);
  wingL.rotation.z = 0.35;
  const wingR = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.35, 2.2), mat(accent, 0.9, 0.4));
  wingR.position.set(2.2, -0.3, 1.4);
  wingR.rotation.z = -0.2;
  const spike = new THREE.Mesh(new THREE.ConeGeometry(0.35, 3.2, 4), mat(0x303336, 0.6, 0.8));
  spike.rotation.x = -Math.PI / 2;
  spike.position.set(0, -0.8, -4.5);
  const t1 = thruster(0.9);
  t1.position.set(0, 0, 4.4);
  g.add(body, wingL, wingR, spike, t1);
  g.scale.setScalar(scale);
  return { group: g, thrusters: [t1], kind: `pirate_${tier}` };
}

export function buildShipMesh(hullId: HullId | 'pirate', pirateTier?: PirateTier | null): ShipView {
  switch (hullId) {
    case 'shuttle': return buildShuttle();
    case 'hauler': return buildHauler();
    case 'prospector': return buildProspector();
    case 'interceptor': return buildInterceptor();
    case 'freighter': return buildFreighter();
    case 'pirate': return buildPirate(pirateTier ?? 'scout');
  }
}

// Per-frame thruster glow update from entity state.
export function updateThrusters(view: ShipView, e: Entity): void {
  const power = e.cruise === 'cruise' ? 1.4 : Math.max(Math.abs(e.throttle), 0.06);
  for (const t of view.thrusters) {
    const flicker = 0.85 + Math.random() * 0.3; // visual only — not sim state
    t.scale.set(power * flicker, power * 2.2 * flicker, power * flicker);
    (t.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.25 + power * 0.7);
  }
}
