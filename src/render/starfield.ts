// Procedural starfield + nebula skybox. Lives in the far scene at the camera
// origin (position 0,0,0 camera-relative => infinitely far parallax).

import * as THREE from 'three';
import { Rng, fbm2 } from '../sim/rng';

export function buildStarfield(seed: number): THREE.Group {
  const group = new THREE.Group();
  const rng = new Rng(seed ^ 0x57a2);

  // --- stars: three shells of points with different brightness ---
  for (const [count, size, brightness] of [[2600, 1.6, 1.0], [4200, 1.0, 0.55], [6000, 0.7, 0.3]] as const) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // uniform direction
      const z = rng.range(-1, 1);
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(1 - z * z);
      const R = 330_000;
      positions[i * 3] = r * Math.cos(a) * R;
      positions[i * 3 + 1] = z * R;
      positions[i * 3 + 2] = r * Math.sin(a) * R;
      // subtle temperature variation
      const t = rng.next();
      const c = new THREE.Color().setHSL(
        t < 0.6 ? 0.62 - t * 0.1 : 0.05 + rng.next() * 0.06,
        rng.range(0.05, 0.45),
        brightness * rng.range(0.45, 1.0),
      );
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size, vertexColors: true, sizeAttenuation: false,
      depthWrite: false, transparent: true, opacity: 0.95,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
  }

  // --- nebula: inside-out sphere with a dark procedural canvas texture ---
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#020205';
  ctx.fillRect(0, 0, 1024, 512);
  const img = ctx.getImageData(0, 0, 1024, 512);
  const d = img.data;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 1024; x++) {
      const n = fbm2(x / 170, y / 110, seed ^ 0xeb1a, 5);
      const m = fbm2(x / 60 + 40, y / 55, seed ^ 0x77f, 4);
      const v = Math.max(0, n - 0.52) * 2.2;          // sparse wisps
      const w = Math.max(0, m - 0.62) * 1.6;
      const i = (y * 1024 + x) * 4;
      d[i] += v * 26 + w * 34;       // rust red
      d[i + 1] += v * 12 + w * 10;
      d[i + 2] += v * 30 + w * 6;    // cold violet
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(345_000, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false, transparent: true, opacity: 1 }),
  );
  sphere.frustumCulled = false;
  group.add(sphere);
  group.renderOrder = -100;
  return group;
}
