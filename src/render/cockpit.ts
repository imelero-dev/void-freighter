// First-person cockpit interior: procedural dashboard, canopy frame and side
// consoles with emissive amber instrument screens. Attached to the camera so
// it never clips — the canonical way to fly.

import * as THREE from 'three';
import { Rng } from '../sim/rng';

function screenTexture(seed: number, w = 256, h = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const rng = new Rng(seed);
  ctx.fillStyle = '#0c0903';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(217, 164, 65, 0.85)';
  ctx.fillStyle = 'rgba(217, 164, 65, 0.85)';
  ctx.lineWidth = 1;
  // panel border
  ctx.strokeRect(3, 3, w - 6, h - 6);
  const kind = rng.int(0, 3);
  if (kind === 0) {
    // bar gauges
    for (let i = 0; i < 6; i++) {
      const x = 14 + i * ((w - 28) / 6);
      const bh = rng.range(0.2, 0.9) * (h - 40);
      ctx.fillRect(x, h - 16 - bh, (w - 28) / 6 - 6, bh);
      ctx.strokeRect(x, 16, (w - 28) / 6 - 6, h - 32);
    }
  } else if (kind === 1) {
    // waveform + readouts
    ctx.beginPath();
    for (let x = 8; x < w - 8; x += 3) {
      const y = h / 2 + Math.sin(x * 0.12 + seed) * rng.range(8, 22);
      x === 8 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.font = '9px monospace';
    for (let i = 0; i < 4; i++) {
      ctx.fillText(`${rng.int(10, 99)}.${rng.int(0, 9)} ${rng.pick(['kPa', 'MW', 'K', 'ΔV'])}`, 10 + i * (w / 4), 16);
    }
  } else if (kind === 2) {
    // orbital schematic
    ctx.translate(w / 2, h / 2);
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.ellipse(0, 0, i * (w / 8), i * (h / 8), 0.2, 0, Math.PI * 2);
      ctx.stroke();
      const a = rng.range(0, Math.PI * 2);
      ctx.fillRect(Math.cos(a) * i * (w / 8) - 2, Math.sin(a) * i * (h / 8) - 2, 4, 4);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    // dense text wall (manifests, logs)
    ctx.font = '8px monospace';
    for (let y = 14; y < h - 8; y += 11) {
      let line = '';
      const n = rng.int(3, 7);
      for (let i = 0; i < n; i++) line += `${rng.pick(['CRG', 'NAV', 'PWR', 'SYS', 'O2', 'THR'])}:${rng.int(0, 999)} `;
      ctx.fillText(line.slice(0, 38), 10, y);
    }
  }
  // scanline overlay
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildCockpit(): THREE.Group {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.85, metalness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.95, metalness: 0.3 });

  const screenMat = (seed: number) => new THREE.MeshStandardMaterial({
    color: 0x111111,
    emissive: 0xffffff,
    emissiveMap: screenTexture(seed),
    emissiveIntensity: 0.55,
    roughness: 0.6,
    metalness: 0.1,
  });

  // main dashboard: three angled slabs below the forward view
  const dashY = -0.52, dashZ = -0.78;
  const mkPanel = (x: number, ry: number, w: number, seed: number) => {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.3), frameMat);
    slab.position.set(x, dashY, dashZ);
    slab.rotation.x = 0.5;
    slab.rotation.y = ry;
    g.add(slab);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.86, 0.115), screenMat(seed));
    screen.position.set(0, 0.082, -0.02);
    screen.rotation.x = -0.45;
    slab.add(screen);
  };
  mkPanel(-0.42, 0.32, 0.42, 101);
  mkPanel(0, 0, 0.5, 202);
  mkPanel(0.42, -0.32, 0.42, 303);

  // dashboard cowl: a lip that hides the seam at the bottom of the view
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.5), darkMat);
  cowl.position.set(0, -0.62, -0.72);
  cowl.rotation.x = 0.35;
  g.add(cowl);

  // side consoles
  for (const side of [-1, 1]) {
    const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.85), frameMat);
    console_.position.set(side * 0.72, -0.58, -0.32);
    console_.rotation.z = side * -0.28;
    console_.rotation.y = side * 0.15;
    g.add(console_);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.4), screenMat(side > 0 ? 404 : 505));
    screen.position.set(0, 0.06, 0.05);
    screen.rotation.x = -Math.PI / 2 + 0.25;
    console_.add(screen);
    // throttle / stick nubs
    const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.12, 6), darkMat);
    nub.position.set(0, 0.1, 0.28);
    nub.rotation.x = side * 0.2;
    console_.add(nub);
  }

  // canopy frame: A-pillars well outboard + overhead spar high up
  const pillarGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.9, 6);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(pillarGeo, darkMat);
    pillar.position.set(side * 1.18, 0.3, -0.58);
    pillar.rotation.z = side * 0.8;
    pillar.rotation.x = 0.2;
    g.add(pillar);
  }
  const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), darkMat);
  spar.rotation.z = Math.PI / 2;
  spar.position.set(0, 1.05, -0.6);
  g.add(spar);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.06, 0.08), darkMat);
  sill.position.set(0, -0.46, -0.95);
  g.add(sill);

  // warm instrument glow
  const glow = new THREE.PointLight(0xd9a441, 0.45, 2.4);
  glow.position.set(0, -0.3, -0.5);
  g.add(glow);

  g.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return g;
}
