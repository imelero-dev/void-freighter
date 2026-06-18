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
import type { SceneManager } from './scene';

const GRID = 16;            // cells per chunk edge (17×17 vertices)
const SPLIT_RATIO = 0.55;   // split while chunkWorldSize / distance exceeds this (chunk subtends ~30°)
const MAX_LEVEL = 16;       // deepest subdivision (≈ sub-metre on a big world)
const MAX_BUILDS_PER_FRAME = 24; // amortise chunk meshing to avoid hitches

const WHITE = new THREE.Color(0xffffff);

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
      vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x202020, emissiveIntensity: 0.2,
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
    let builtThisFrame = 0;
    const visit = (node: QNode): void => {
      const dist = this.tmpA.copy(node.anchor).sub(this.camWorld).length();
      const wantSplit = node.level < MAX_LEVEL && node.worldSize / Math.max(1, dist) > SPLIT_RATIO;
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
        if (node.mesh.visible) this.reach = Math.max(this.reach, dist + node.worldSize);
      }
    };
    for (const r of this.roots) visit(r);
    this.active = true;
  }

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
    // pass 1: grid positions (relative to the chunk anchor) + heights
    for (let j = 0; j < n; j++) {
      const v = node.v0 + (node.v1 - node.v0) * (j / GRID);
      for (let i = 0; i < n; i++) {
        const u = node.u0 + (node.u1 - node.u0) * (i / GRID);
        cubeToSphere(F.n.x + F.a.x * u + F.b.x * v, F.n.y + F.a.y * u + F.b.y * v, F.n.z + F.a.z * u + F.b.z * v, dir);
        const h = heightField(this.planet.pos.x + dir.x * R, this.planet.pos.z + dir.z * R, seed, prm);
        const k = j * n + i;
        heights[k] = h;
        pos[k * 3] = this.planet.pos.x + dir.x * (R + h) - ax.x;
        pos[k * 3 + 1] = this.planet.pos.y + dir.y * (R + h) - ax.y;
        pos[k * 3 + 2] = this.planet.pos.z + dir.z * (R + h) - ax.z;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // skirt: drop a copy of each border vertex down along -up, stitched to the
    // rim, so LOD-boundary cracks are filled by a vertical apron instead of a gap
    // skirt depth scales with the CHUNK, not the global relief — a small low-
    // altitude chunk needs only a small apron, or it juts out as a dark wall
    const skirtDepth = Math.min(prm.amp, node.worldSize * 0.18);
    let s = gridVerts;
    const skirtOf = new Map<number, number>();
    const addSkirt = (gi: number): number => {
      let si = skirtOf.get(gi);
      if (si !== undefined) return si;
      si = s++;
      pos[si * 3] = pos[gi * 3] - up.x * skirtDepth;
      pos[si * 3 + 1] = pos[gi * 3 + 1] - up.y * skirtDepth;
      pos[si * 3 + 2] = pos[gi * 3 + 2] - up.z * skirtDepth;
      heights[si] = heights[gi];
      skirtOf.set(gi, si);
      return si;
    };
    const edge = (g0: number, g1: number) => {
      const s0 = addSkirt(g0), s1 = addSkirt(g1);
      idx.push(g0, s0, g1, g1, s0, s1);
    };
    for (let i = 0; i < GRID; i++) edge(i, i + 1);                                  // top (j=0)
    for (let i = 0; i < GRID; i++) edge(GRID * n + i + 1, GRID * n + i);            // bottom (j=GRID)
    for (let j = 0; j < GRID; j++) edge((j + 1) * n, j * n);                        // left (i=0)
    for (let j = 0; j < GRID; j++) edge(j * n + GRID, (j + 1) * n + GRID);          // right (i=GRID)

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // pass 2: colour by height + slope (after normals exist)
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < verts; k++) {
      const t = Math.min(1, Math.max(0, heights[k] / prm.amp));
      tmpCol.copy(pal.lo).lerp(pal.hi, Math.pow(t, 0.7));
      // skirt vertices (k >= gridVerts) skip the slope→rock term: their sideways
      // normal would read as cliff and paint a dark wall, defeating the hide
      if (k < gridVerts) {
        const slope = 1 - Math.min(1, Math.max(0, nor.getX(k) * up.x + nor.getY(k) * up.y + nor.getZ(k) * up.z));
        tmpCol.lerp(pal.rock, Math.min(1, slope * 2.2) * 0.85);
      }
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
          gl_FragColor.rgb = gl_FragColor.rgb * _ext + uInsCol * _ins;
        #endif`,
      );
    };
    mat.customProgramCacheKey = () => 'vf_quad_aerial';
  }
}
