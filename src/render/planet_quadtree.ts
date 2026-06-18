// Cube-sphere quadtree planet (the "real" seamless-landing technique, #16).
//
// The planet is the 6 faces of a cube, each the root of a quadtree. A node holds
// a GRID×GRID chunk of surface; it SUBDIVIDES into four children when it grows
// too large on screen (its world size over its distance to the camera exceeds a
// threshold) and MERGES back when small. So the ground directly under you keeps
// subdividing to fine relief as you descend — continuous detail at every
// altitude, from orbit to a few metres — while distant ground stays coarse and
// cheap. Chunks are built in double precision relative to their own anchor and
// drawn camera-relative (floating origin), so there's no jitter at planetary
// scale. Vertices sample the SAME heightField as the sim's collision, so you
// land on exactly what you see. Skirts hide the cracks between LOD levels.

import * as THREE from 'three';
import type { PlanetDef } from '../sim/types';
import { heightField, TERRAIN } from '../sim/terrain';
import { fbm2 } from '../sim/rng';
import { GROUND_MID } from './terrain';
import type { SceneManager } from './scene';

const GRID = 32;            // cells per chunk edge (33×33 vertices) — fine detail per chunk
const SPLIT_RATIO = 0.4;    // split while chunkWorldSize / distance exceeds this
const MAX_LEVEL = 10;       // capped: deeper levels starve the build budget and leave
                            // coarse grazing chunks that streak. 10 + a dense grid gives
                            // ~30 m cells near the ground without that artifact.
const MAX_BUILDS_PER_FRAME = 20; // amortise chunk meshing to avoid hitches
const SKIRTS = true;

const WHITE = new THREE.Color(0xffffff);
const SNOW = new THREE.Color(0xeef2f6);
const WATER_DEEP = new THREE.Color(0x1c3a5e);
const WATER_SHALLOW = new THREE.Color(0x2f6f86);

const GROUND: Record<string, { lo: THREE.Color; hi: THREE.Color; rock: THREE.Color }> = {
  rocky:  { lo: new THREE.Color(0x4a4138), hi: new THREE.Color(0x9c8d76), rock: new THREE.Color(0x332c25) },
  terran: { lo: new THREE.Color(0x33502c), hi: new THREE.Color(0xa59a6d), rock: new THREE.Color(0x4b3f30) },
  barren: { lo: new THREE.Color(0x564f45), hi: new THREE.Color(0xa39a8a), rock: new THREE.Color(0x3a342c) },
  ice:    { lo: new THREE.Color(0x8fa6b4), hi: new THREE.Color(0xf2f9ff), rock: new THREE.Color(0x6b8290) },
  lava:   { lo: new THREE.Color(0x1c100c), hi: new THREE.Color(0xd6571c), rock: new THREE.Color(0x140a07) },
  gas:    { lo: new THREE.Color(0x53536a), hi: new THREE.Color(0x9a9ac0), rock: new THREE.Color(0x3c3c50) },
};

// 6 cube faces: outward normal + the two in-plane axes spanning [-1,1]²
const FACES: { n: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 }[] = [
  { n: new THREE.Vector3(1, 0, 0), a: new THREE.Vector3(0, 1, 0), b: new THREE.Vector3(0, 0, 1) },
  { n: new THREE.Vector3(-1, 0, 0), a: new THREE.Vector3(0, 1, 0), b: new THREE.Vector3(0, 0, -1) },
  { n: new THREE.Vector3(0, 1, 0), a: new THREE.Vector3(0, 0, 1), b: new THREE.Vector3(1, 0, 0) },
  { n: new THREE.Vector3(0, -1, 0), a: new THREE.Vector3(0, 0, -1), b: new THREE.Vector3(1, 0, 0) },
  { n: new THREE.Vector3(0, 0, 1), a: new THREE.Vector3(1, 0, 0), b: new THREE.Vector3(0, 1, 0) },
  { n: new THREE.Vector3(0, 0, -1), a: new THREE.Vector3(-1, 0, 0), b: new THREE.Vector3(0, 1, 0) },
];

// cube point -> sphere direction (even-area mapping; less distortion than a
// plain normalize at the cube corners)
function cubeToSphere(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out.set(
    x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3),
    y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3),
    z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3),
  );
  return out;
}

interface QNode {
  face: number;
  u0: number; v0: number; u1: number; v1: number;
  level: number;
  children: QNode[] | null;
  mesh: THREE.Mesh | null;
  anchor: THREE.Vector3;     // chunk-centre world position (build origin)
  centerDir: THREE.Vector3;  // unit sphere direction at the chunk centre
  worldSize: number;         // approximate chunk span on the surface (m)
  built: boolean;
}

export class PlanetQuadtree {
  private group = new THREE.Group();
  private mat: THREE.MeshStandardMaterial;
  private roots: QNode[] = [];
  private buildQueue: QNode[] = [];
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private camWorld = new THREE.Vector3();

  // aerial-perspective uniforms (per-channel extinction + blue inscatter)
  private aerial = {
    uExt: { value: new THREE.Vector3() },
    uIns: { value: 0 },
    uInsCol: { value: new THREE.Color(0x6fa8d6) },
  };

  active = false;
  reach = 0; // distance (m) to the farthest visible chunk — fits the near far-plane

  constructor(private sm: SceneManager, private planet: PlanetDef) {
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0, flatShading: false,
      emissive: 0x202020, emissiveIntensity: 0.2,
      side: THREE.DoubleSide, // robust against any chunk/skirt winding
    });
    this.patchAerialFog(this.mat);
    this.group.renderOrder = -10;
    sm.near.add(this.group);
    for (let f = 0; f < 6; f++) this.roots.push(this.makeNode(f, -1, -1, 1, 1, 0));
  }

  dispose(): void {
    this.sm.near.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }

  private makeNode(face: number, u0: number, v0: number, u1: number, v1: number, level: number): QNode {
    const R = this.planet.radius;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const F = FACES[face];
    const cx = F.n.x + F.a.x * cu + F.b.x * cv;
    const cy = F.n.y + F.a.y * cu + F.b.y * cv;
    const cz = F.n.z + F.a.z * cu + F.b.z * cv;
    const dir = cubeToSphere(cx, cy, cz, new THREE.Vector3());
    const h = heightField(this.planet.pos.x + dir.x * R, this.planet.pos.z + dir.z * R, this.planet.colorSeed, TERRAIN[this.planet.kind]);
    const anchor = new THREE.Vector3(
      this.planet.pos.x + dir.x * (R + h),
      this.planet.pos.y + dir.y * (R + h),
      this.planet.pos.z + dir.z * (R + h),
    );
    // span ≈ great-circle arc across the node
    const worldSize = (u1 - u0) * R * (Math.PI / 4) * Math.SQRT2;
    return { face, u0, v0, u1, v1, level, children: null, mesh: null, anchor, centerDir: dir, worldSize, built: false };
  }

  // Decide split/merge against the camera each frame, then place visible leaves.
  update(camWorld: { x: number; y: number; z: number }, origin: { x: number; y: number; z: number }): void {
    this.camWorld.set(camWorld.x, camWorld.y, camWorld.z);
    this.reach = 0;
    // altitude drives the far-plane cap: when low, thick haze hides the deep
    // distance, so we keep the near far-plane tight for sane depth precision
    // (the wide range from cockpit-near to horizon-far is what tears into
    // z-fighting streaks); high up in thin air we let it reach the full horizon.
    const camAlt = Math.max(20, this.tmpA.set(this.camWorld.x - this.planet.pos.x, this.camWorld.y - this.planet.pos.y, this.camWorld.z - this.planet.pos.z).length() - this.planet.radius);
    // tight far-plane: render the high-detail ground only out to roughly where
    // the haze swallows it, then let the hazed far-scene sphere carry the
    // horizon. This clips the coarse grazing-angle chunks that streak, and keeps
    // depth precision sane. Opens up high in thin air where you must see far.
    // Far-plane ceiling: detailed ground out to roughly the haze line, the smooth
    // far-scene sphere carries the deep horizon. Smooth shading keeps the flat
    // coarse chunks from faceting at grazing angles, so this can stay generous.
    const reachCap = Math.min(90_000, Math.max(13_000, camAlt * 2.4));
    // Distance-fade FLOOR: regardless of how thin the air is, fade the detailed
    // terrain into the sky by the far-plane, so the coarse grazing chunks at the
    // edge dissolve (no streaks) and the hazed far-scene sphere takes over with no
    // visible cut. Below, the real atmospheric haze is stronger and wins.
    const fadeFloor = 1.7 / reachCap;
    const ex = this.aerial.uExt.value;
    ex.x = Math.max(ex.x, fadeFloor * 1.2); ex.y = Math.max(ex.y, fadeFloor); ex.z = Math.max(ex.z, fadeFloor * 0.72);
    this.aerial.uIns.value = Math.max(this.aerial.uIns.value, fadeFloor * 0.95);
    let builtThisFrame = 0;
    let leaves = 0;
    const visit = (node: QNode): void => {
      const dist = this.tmpA.copy(node.anchor).sub(this.camWorld).length();
      const ratio = node.worldSize / Math.max(1, dist);
      // hysteresis: a node splits at SPLIT_RATIO but, once split, only merges back
      // when it falls well under it — so a chunk hovering at the threshold doesn't
      // flicker between LOD levels frame to frame as you fly
      const threshold = node.children ? SPLIT_RATIO * 0.6 : SPLIT_RATIO;
      const wantSplit = node.level < MAX_LEVEL && ratio > threshold;
      // horizon cull: drop nodes on the far backside of the globe (their outward
      // direction points away from the camera's direction off the planet centre)
      const facing = node.centerDir.dot(
        this.tmpDir.set(this.camWorld.x - this.planet.pos.x, this.camWorld.y - this.planet.pos.y, this.camWorld.z - this.planet.pos.z).normalize(),
      );
      if (wantSplit) {
        if (!node.children) this.subdivide(node);
        if (node.mesh) node.mesh.visible = false;
        for (const c of node.children!) visit(c);
        return;
      }
      // leaf: collapse any children, show this chunk
      if (node.children) this.collapse(node);
      if (!node.built) {
        if (builtThisFrame < MAX_BUILDS_PER_FRAME) { this.build(node); builtThisFrame++; }
        else { this.buildQueue.push(node); }
      }
      if (node.mesh) {
        node.mesh.visible = facing > -0.35; // drop the far backside of the globe
        node.mesh.position.set(node.anchor.x - origin.x, node.anchor.y - origin.y, node.anchor.z - origin.z);
        if (node.mesh.visible) { leaves++; this.reach = Math.min(reachCap, Math.max(this.reach, dist + node.worldSize)); }
      }
    };
    for (const r of this.roots) visit(r);
    this.active = true;
    this.leafCount = leaves;
  }
  leafCount = 0;

  private subdivide(node: QNode): void {
    const { face, u0, v0, u1, v1, level } = node;
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    node.children = [
      this.makeNode(face, u0, v0, um, vm, level + 1),
      this.makeNode(face, um, v0, u1, vm, level + 1),
      this.makeNode(face, u0, vm, um, v1, level + 1),
      this.makeNode(face, um, vm, u1, v1, level + 1),
    ];
  }

  private collapse(node: QNode): void {
    if (!node.children) return;
    for (const c of node.children) {
      this.collapse(c);
      if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; c.built = false; }
    }
    node.children = null;
  }

  // Build a chunk's mesh: GRID×GRID quads of displaced sphere surface, plus a
  // skirt hanging from the rim that hides the cracks against coarser neighbours.
  private build(node: QNode): void {
    const R = this.planet.radius;
    const seed = this.planet.colorSeed;
    const prm = TERRAIN[this.planet.kind];
    const pal = GROUND[this.planet.kind] ?? GROUND.barren;
    const F = FACES[node.face];
    const n = GRID + 1;
    const gridVerts = n * n;
    const border = 4 * GRID;               // perimeter vertices that get a skirt
    const verts = gridVerts + border;
    const pos = new Float32Array(verts * 3);
    const colArr = new Float32Array(verts * 3);
    const dir = new THREE.Vector3();
    const tmpCol = new THREE.Color();
    const heights = new Float32Array(verts);
    const ax = node.anchor;
    const up = node.centerDir;
    // Relief by LOD level: coarse (low-level = far/grazing) chunks flatten toward
    // a smooth sphere; fine (near) chunks carry full relief. This kills the streaks
    // from tall features rendered edge-on at the horizon (coarse cells can't hold a
    // 2 km ridge without slivering), gives the flat-far / detailed-near read of real
    // aerial perspective, and the gradual growth as you descend is hidden by haze.
    // Coarse/far chunks go FULLY flat (a smooth sphere); relief ramps in only on
    // the finer near levels. Any relief left on a coarse chunk slivers into streaks
    // when seen edge-on at the horizon during fast flight, so the far field must be
    // truly flat — the haze and the ramp hide the transition as you descend.
    const reliefFactor = Math.max(0, Math.min(1, (node.level - 6) / 3));
    const rawH = new Float32Array(verts); // unattenuated height (LOD-stable colouring)
    const vary = new Float32Array(verts);  // patchy tone variation
    const dirs = new Float32Array(verts * 3); // radial (sphere) normal per vertex
    // pass 1: grid positions (relative to the chunk anchor) + heights
    for (let j = 0; j < n; j++) {
      const v = node.v0 + (node.v1 - node.v0) * (j / GRID);
      for (let i = 0; i < n; i++) {
        const u = node.u0 + (node.u1 - node.u0) * (i / GRID);
        cubeToSphere(F.n.x + F.a.x * u + F.b.x * v, F.n.y + F.a.y * u + F.b.y * v, F.n.z + F.a.z * u + F.b.z * v, dir);
        const wx = this.planet.pos.x + dir.x * R, wz = this.planet.pos.z + dir.z * R;
        const r = heightField(wx, wz, seed, prm);
        const h = r * reliefFactor;
        const k = j * n + i;
        heights[k] = h; rawH[k] = r;
        dirs[k * 3] = dir.x; dirs[k * 3 + 1] = dir.y; dirs[k * 3 + 2] = dir.z;
        vary[k] = fbm2(wx * 0.00085, wz * 0.00085, seed ^ 0x55a3, 3); // 0..1 patchy
        pos[k * 3] = this.planet.pos.x + dir.x * (R + h) - ax.x;
        pos[k * 3 + 1] = this.planet.pos.y + dir.y * (R + h) - ax.y;
        pos[k * 3 + 2] = this.planet.pos.z + dir.z * (R + h) - ax.z;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, b, c, b, d, c); // outward winding (normal points away from the planet)
      }
    }
    // skirt: drop a copy of each border vertex down along -up, stitched to the
    // rim, so LOD-boundary cracks are filled by a vertical apron instead of a gap
    // Skirt depth scales with the chunk's actual RELIEF, not its size: a flat far
    // chunk's T-junction crack is only the curvature sag (sub-metre), so it gets a
    // tiny apron (no streak-wall at grazing); a detailed near chunk gets enough to
    // plug the real relief gap against a coarser neighbour.
    const skirtDepth = Math.max(8, reliefFactor * 130);
    let s = gridVerts;
    const skirtOf = new Map<number, number>();
    const addSkirt = (gi: number): number => {
      let si = skirtOf.get(gi);
      if (si !== undefined) return si;
      si = s++;
      pos[si * 3] = pos[gi * 3] - up.x * skirtDepth;
      pos[si * 3 + 1] = pos[gi * 3 + 1] - up.y * skirtDepth;
      pos[si * 3 + 2] = pos[gi * 3 + 2] - up.z * skirtDepth;
      heights[si] = heights[gi]; rawH[si] = rawH[gi]; vary[si] = vary[gi];
      dirs[si * 3] = dirs[gi * 3]; dirs[si * 3 + 1] = dirs[gi * 3 + 1]; dirs[si * 3 + 2] = dirs[gi * 3 + 2];
      skirtOf.set(gi, si);
      return si;
    };
    const edge = (g0: number, g1: number) => {
      const s0 = addSkirt(g0), s1 = addSkirt(g1);
      idx.push(g0, s0, g1, g1, s0, s1);
    };
    if (SKIRTS) {
      for (let i = 0; i < GRID; i++) edge(i, i + 1);                                  // top (j=0)
      for (let i = 0; i < GRID; i++) edge(GRID * n + i + 1, GRID * n + i);            // bottom (j=GRID)
      for (let j = 0; j < GRID; j++) edge((j + 1) * n, j * n);                        // left (i=0)
      for (let j = 0; j < GRID; j++) edge(j * n + GRID, (j + 1) * n + GRID);          // right (i=GRID)
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Blend normals toward the CONTINUOUS radial (sphere) normal by (1-relief):
    // per-chunk computeVertexNormals leaves the edge normals discontinuous between
    // neighbouring chunks, which paints a lit/dark seam at every boundary — and
    // those seams stack into streaks at grazing angles. Flat far chunks become pure
    // sphere normals (seamless); near detailed chunks keep their computed relief.
    {
      const na = geo.attributes.normal as THREE.BufferAttribute;
      const blend = 1 - reliefFactor;
      if (blend > 0.001) {
        for (let k = 0; k < verts; k++) {
          let nx = na.getX(k) * (1 - blend) + dirs[k * 3] * blend;
          let ny = na.getY(k) * (1 - blend) + dirs[k * 3 + 1] * blend;
          let nz = na.getZ(k) * (1 - blend) + dirs[k * 3 + 2] * blend;
          const l = Math.hypot(nx, ny, nz) || 1;
          na.setXYZ(k, nx / l, ny / l, nz / l);
        }
        na.needsUpdate = true;
      }
    }
    // pass 2: colour by height + slope (after normals exist). Uses the RAW
    // (unattenuated) height so coastlines/snowlines stay put across LOD levels.
    const water = this.planet.kind === 'terran';
    const sea = prm.amp * 0.16;       // sea level (raw height) on water worlds
    const snow = prm.amp * 0.82;      // snow cap on high peaks
    // Coarse/far chunks (low reliefFactor) collapse to a uniform mid-tone: the
    // per-vertex colour variation paints facets onto a big flat chunk that streak
    // at grazing angles, so the detail (slope rock, patches, water, snow) only
    // emerges as relief ramps in near the ground. The mid-tone matches the far
    // sphere's tint, so the terrain↔sphere handoff is seamless too.
    const midTone = GROUND_MID[this.planet.kind] ?? GROUND_MID.barren;
    const uniformity = (1 - reliefFactor) * 0.7;
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < verts; k++) {
      const r = rawH[k];
      const t = Math.min(1, Math.max(0, r / prm.amp));
      tmpCol.copy(pal.lo).lerp(pal.hi, Math.pow(t, 0.7));
      if (k < gridVerts) {
        const slope = 1 - Math.min(1, Math.max(0, nor.getX(k) * up.x + nor.getY(k) * up.y + nor.getZ(k) * up.z));
        tmpCol.lerp(pal.rock, Math.min(1, slope * 2.2) * 0.85);
      }
      tmpCol.multiplyScalar(0.82 + vary[k] * 0.34);            // patchy tone variation
      if (r > snow) tmpCol.lerp(SNOW, Math.min(1, (r - snow) / (prm.amp * 0.18)) * 0.8); // snow caps
      if (water && r < sea) tmpCol.copy(WATER_DEEP).lerp(WATER_SHALLOW, Math.max(0, r / sea)); // basins
      if (uniformity > 0.001) tmpCol.lerp(midTone, uniformity); // far chunks → smooth uniform tone
      colArr[k * 3] = tmpCol.r; colArr[k * 3 + 1] = tmpCol.g; colArr[k * 3 + 2] = tmpCol.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.receiveShadow = true;
    node.mesh = mesh;
    node.built = true;
    this.group.add(mesh);
  }

  // update the shared aerial-perspective + skylight uniforms each frame
  setAtmosphere(skyColor: THREE.Color, hazeD: number, emissive: number): void {
    const base = hazeD * 0.62e-4;
    this.aerial.uExt.value.set(base * 1.3, base * 1.02, base * 0.6);
    this.aerial.uIns.value = base * 0.95;
    this.aerial.uInsCol.value.copy(skyColor).lerp(WHITE, 0.35).multiplyScalar(1.05);
    this.mat.emissiveIntensity = emissive;
    this.mat.emissive.copy((GROUND[this.planet.kind] ?? GROUND.barren).lo).multiplyScalar(0.6);
  }

  // drain a few queued chunk builds per frame (amortised)
  drainBuilds(): void {
    let n = 0;
    while (this.buildQueue.length && n < MAX_BUILDS_PER_FRAME) {
      const node = this.buildQueue.shift()!;
      if (!node.built) { this.build(node); n++; }
    }
  }

  private patchAerialFog(mat: THREE.MeshStandardMaterial): void {
    mat.fog = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uExt = this.aerial.uExt;
      shader.uniforms.uIns = this.aerial.uIns;
      shader.uniforms.uInsCol = this.aerial.uInsCol;
      shader.fragmentShader = 'uniform vec3 uExt;\nuniform float uIns;\nuniform vec3 uInsCol;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 _de = vFogDepth * uExt;
          vec3 _ext = exp(-_de * _de);
          float _di = vFogDepth * uIns;
          float _ins = 1.0 - exp(-_di * _di);
          // GRAZING fade: ground seen edge-on (toward the horizon) is where coarse
          // chunks sliver into streaks — so dissolve it into the sky, while the
          // ground you look down at (the landing zone) stays crisp and clear.
          float _graze = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
          float _gz = smoothstep(0.62, 0.985, _graze) * smoothstep(2500.0, 9000.0, vFogDepth);
          _ext *= (1.0 - _gz);
          _ins = max(_ins, _gz);
          gl_FragColor.rgb = gl_FragColor.rgb * _ext + uInsCol * _ins;
        #endif`,
      );
    };
    mat.customProgramCacheKey = () => 'vf_quad_aerial';
  }
}
