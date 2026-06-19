// Syncs dynamic sim entities (ships, asteroids, fragments, loot, missiles)
// to three.js objects in the near scene, with tick interpolation.

import * as THREE from 'three';
import { noise3, Rng } from '../sim/rng';
import type { Entity, RockType } from '../sim/types';
import type { IWorld } from '../world_api';
import { SceneManager } from './scene';
import { buildShipMesh, updateThrusters, type ShipView } from './ships';

const tmpV = new THREE.Vector3();
const tmpQ1 = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Asteroid geometry pool: deformed icospheres per rock type
// ---------------------------------------------------------------------------

const ROCK_COLORS: Record<RockType, number> = {
  rocky: 0x6e6258, metallic: 0x7a6c58, icy: 0x9fb6bd, rare: 0x8a7f9f,
};

function deformedRock(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = noise3(x * 1.6 + 10, y * 1.6 + 10, z * 1.6 + 10, seed);
    const n2 = noise3(x * 4 + 40, y * 4, z * 4, seed ^ 0x99);
    const s = 0.72 + n * 0.45 + n2 * 0.18;
    pos.setXYZ(i, x * s, y * s, z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

const rockGeoPool: THREE.BufferGeometry[] = [];
function rockGeo(index: number): THREE.BufferGeometry {
  if (rockGeoPool.length === 0) {
    for (let i = 0; i < 10; i++) rockGeoPool.push(deformedRock(1000 + i * 77));
  }
  return rockGeoPool[Math.abs(index) % rockGeoPool.length];
}

const rockMats = new Map<RockType, THREE.MeshStandardMaterial>();
function rockMat(t: RockType): THREE.MeshStandardMaterial {
  let m = rockMats.get(t);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: ROCK_COLORS[t], roughness: 0.95, metalness: t === 'metallic' || t === 'rare' ? 0.5 : 0.1, flatShading: true });
    rockMats.set(t, m);
  }
  return m;
}

// fragment / loot shared assets
const fragGeo = new THREE.TetrahedronGeometry(1.6, 0);
const fragMats: Record<string, THREE.MeshStandardMaterial> = {};
function fragMat(goodId: string | null): THREE.MeshStandardMaterial {
  const key = goodId ?? 'x';
  if (!fragMats[key]) {
    const rng = new Rng(key.length * 7 + key.charCodeAt(0));
    fragMats[key] = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(rng.next(), 0.25, 0.5),
      roughness: 0.6, metalness: 0.6, flatShading: true,
      emissive: 0x202020,
    });
  }
  return fragMats[key];
}
const lootGeo = new THREE.BoxGeometry(2.6, 2.6, 2.6);
const lootMat = new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.5, metalness: 0.7, emissive: 0x332200 });
// weapon bolts: shared elongated tracer (cylinder axis +Y), oriented per frame.
// Beefier than a thin line so shots read with weight (#12).
const boltGeo = new THREE.CylinderGeometry(0.7, 0.7, 14, 6, 1, true);
const boltMat = new THREE.MeshBasicMaterial({
  color: 0xff7a3a, transparent: true, opacity: 0.98,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
// soft glow sleeve around the tracer core — shared, never disposed
const boltGlowGeo = new THREE.CylinderGeometry(1.7, 1.7, 16, 6, 1, true);
const boltGlowMat = new THREE.MeshBasicMaterial({
  color: 0xffae5a, transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();

interface View {
  obj: THREE.Object3D;
  ship?: ShipView;
  kindKey: string;
}

export class EntitiesLayer {
  showPlayer = false; // chase camera shows your own ship
  private views = new Map<number, View>();

  constructor(private sm: SceneManager, private world: IWorld) {}

  update(time: number): void {
    const { world, sm } = this;
    const alpha = Math.min(1, world.renderAlpha);
    const seen = new Set<number>();

    for (const e of world.entities.values()) {
      // own ship handled by the camera layer (cockpit hides it; 3rd person shows it)
      seen.add(e.id);
      let view = this.views.get(e.id);
      const kindKey = e.kind === 'ship' ? `ship_${e.hullId}_${e.pirate ?? ''}_${e.npc ?? ''}${e.derelict ? '_dead' : ''}` : e.kind;
      if (view && view.kindKey !== kindKey) {
        this.dispose(e.id);
        view = undefined;
      }
      if (!view) {
        view = this.create(e, kindKey);
        this.views.set(e.id, view);
      }
      // interpolated world position -> near-scene local
      tmpV.set(
        e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha - sm.origin.x,
        e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha - sm.origin.y,
        e.prevPos.z + (e.pos.z - e.prevPos.z) * alpha - sm.origin.z,
      );
      view.obj.position.copy(tmpV);
      // cull distant ones cheaply
      view.obj.visible = tmpV.lengthSq() < 60_000 * 60_000;
      if (!view.obj.visible) continue;

      if (e.kind === 'ship' || e.kind === 'missile') {
        tmpQ1.set(e.prevOrient.x, e.prevOrient.y, e.prevOrient.z, e.prevOrient.w);
        tmpQ2.set(e.orient.x, e.orient.y, e.orient.z, e.orient.w);
        view.obj.quaternion.slerpQuaternions(tmpQ1, tmpQ2, alpha);
        if (view.ship) updateThrusters(view.ship, e);
        const strobe = view.obj.userData.strobe as THREE.Mesh | undefined;
        if (strobe) strobe.visible = Math.sin(time * 7 + e.id) > 0.2;
        if (e.id === world.playerId && !this.showPlayer) view.obj.visible = false;
        if (e.dockedAt) view.obj.visible = false;
      } else if (e.kind === 'bolt') {
        tmpDir.set(e.vel.x, e.vel.y, e.vel.z).normalize();
        view.obj.quaternion.setFromUnitVectors(Y_AXIS, tmpDir);
      } else if (e.kind === 'fragment' || e.kind === 'loot') {
        const spin = time * 1.2 + e.id;
        view.obj.rotation.set(spin * 0.7, spin, 0);
      }
    }

    for (const id of [...this.views.keys()]) {
      if (!seen.has(id)) this.dispose(id);
    }
  }

  playerObject(): THREE.Object3D | null {
    return this.views.get(this.world.playerId)?.obj ?? null;
  }

  objectFor(id: number): THREE.Object3D | null {
    return this.views.get(id)?.obj ?? null;
  }

  private create(e: Entity, kindKey: string): View {
    let view: View;
    switch (e.kind) {
      case 'ship': {
        const ship = buildShipMesh(e.hullId, e.pirate);
        // ambient traffic paint jobs
        if (e.npc) {
          if (e.npc === 'superfreighter') {
            ship.group.scale.setScalar(14); // half a kilometre of cargo sliding past
          } else if (e.npc === 'patrol') {
            // police: pale hull + blue strobe
            ship.group.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (mesh.isMesh) {
                const m = mesh.material as THREE.MeshStandardMaterial;
                if (m.color) m.color.lerp(new THREE.Color(0xcdd8e4), 0.55);
              }
            });
            const strobe = new THREE.Mesh(
              new THREE.SphereGeometry(0.8, 6, 6),
              new THREE.MeshBasicMaterial({ color: 0x55aaff }),
            );
            strobe.position.set(0, 2.2, 0);
            ship.group.add(strobe);
            ship.group.userData.strobe = strobe;
          } else if (e.npc === 'merchant') {
            ship.group.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (mesh.isMesh) {
                const m = mesh.material as THREE.MeshStandardMaterial;
                if (m.color) m.color.lerp(new THREE.Color(0xd8b46a), 0.3);
              }
            });
            const lamp = new THREE.Mesh(
              new THREE.SphereGeometry(0.7, 6, 6),
              new THREE.MeshBasicMaterial({ color: 0xffcc66 }),
            );
            lamp.position.set(0, 3.4, 0);
            ship.group.add(lamp);
          } else {
            // civilian liveries: muted blue-gray
            ship.group.traverse((node) => {
              const mesh = node as THREE.Mesh;
              if (mesh.isMesh) {
                const m = mesh.material as THREE.MeshStandardMaterial;
                if (m.color) m.color.lerp(new THREE.Color(0x8fa3b0), 0.22);
              }
            });
          }
        }
        ship.group.traverse((node) => {
          const m = node as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        if (e.derelict) {
          // cold hull: darken everything, kill thruster glow + running lights
          ship.group.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (mesh.isMesh) {
              const m = mesh.material as THREE.MeshStandardMaterial;
              if (m.color) m.color.multiplyScalar(0.3);
              if ('emissive' in m && m.emissive) m.emissive.setHex(0x000000);
              m.opacity = 1;
            }
            if ((node as THREE.Sprite).isSprite) node.visible = false; // nav lights + engine bloom
          });
          for (const t of ship.thrusters) t.visible = false;
          ship.thrusters.length = 0;
          ship.glows.length = 0;
        }
        view = { obj: ship.group, ship, kindKey };
        break;
      }
      case 'asteroid': {
        const mesh = new THREE.Mesh(rockGeo(e.rockIndex), rockMat(e.rockType ?? 'rocky'));
        mesh.scale.setScalar(e.radius);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const wrapper = new THREE.Group();
        wrapper.add(mesh);
        // glowing mineral seams: mine these spots for the good ore
        if (e.hotspots) {
          const seamColor = e.rockType === 'rare' ? 0xc9a0ff : e.rockType === 'icy' ? 0x9fdcff : 0xffd27a;
          for (const h of e.hotspots) {
            const seam = new THREE.Mesh(
              new THREE.SphereGeometry(Math.max(2, e.radius * 0.07), 6, 6),
              new THREE.MeshBasicMaterial({ color: seamColor }),
            );
            seam.position.set(h.x * e.radius * 0.98, h.y * e.radius * 0.98, h.z * e.radius * 0.98);
            wrapper.add(seam);
          }
        }
        view = { obj: wrapper, kindKey };
        break;
      }
      case 'fragment': {
        const mesh = new THREE.Mesh(fragGeo, fragMat(e.goodId));
        view = { obj: mesh, kindKey };
        break;
      }
      case 'loot': {
        const mesh = new THREE.Mesh(lootGeo, lootMat);
        view = { obj: mesh, kindKey };
        break;
      }
      case 'bolt': {
        const mesh = new THREE.Mesh(boltGeo, boltMat); // shared pool — never disposed
        mesh.add(new THREE.Mesh(boltGlowGeo, boltGlowMat)); // glow sleeve
        view = { obj: mesh, kindKey };
        break;
      }
      case 'missile': {
        // per-instance resources: missile views are disposed on impact
        const mesh = new THREE.Mesh(
          new THREE.ConeGeometry(0.5, 3, 6),
          new THREE.MeshBasicMaterial({ color: 0xffcc66 }),
        );
        mesh.rotation.x = -Math.PI / 2;
        const wrapper = new THREE.Group();
        wrapper.add(mesh);
        const flame = new THREE.Mesh(
          new THREE.ConeGeometry(0.4, 2, 6),
          new THREE.MeshBasicMaterial({ color: 0xff8830, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        flame.rotation.x = Math.PI / 2;
        flame.position.z = 2.4;
        wrapper.add(flame);
        view = { obj: wrapper, kindKey };
        break;
      }
    }
    this.sm.near.add(view.obj);
    return view;
  }

  private dispose(id: number): void {
    const view = this.views.get(id);
    if (!view) return;
    this.sm.near.remove(view.obj);
    // ship/missile meshes own their geometries+materials; pooled assets
    // (rocks, fragments, loot) are shared and must survive
    if (view.kindKey.startsWith('ship_') || view.kindKey === 'missile') {
      view.obj.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose();
        } else if ((node as THREE.Sprite).isSprite) {
          // nav-light / engine-glow sprites own their material (the glow
          // texture is shared and must survive)
          (node as THREE.Sprite).material?.dispose();
        }
      });
    }
    this.views.delete(id);
  }
}
