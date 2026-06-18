// Atmospheric sky seen from inside a planet's air: a gradient dome (deep
// overhead, pale and hazy at the horizon) with the sun burning in it, plus a
// drifting deck of broken cloud overhead. Both fade out as you climb back into
// vacuum, where the real starfield and far-scene sun take over.

import * as THREE from 'three';
import { fbm2 } from '../sim/rng';
import type { SystemDef } from '../sim/types';
import { atmoHeight, atmosphereAt } from '../sim/system';
import type { SceneManager } from './scene';

const tmpUp = new THREE.Vector3();
const tmpSun = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

// ---- gradient sky dome with a sun ------------------------------------------

export class SkyDome {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(private sm: SceneManager) {
    this.mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, transparent: true, fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0x2a6fb0) },
        uHorizon: { value: new THREE.Color(0xbfd8ee) },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(0xfff2d6) },
        uOpacity: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uUp;
        uniform vec3 uSunCol; uniform float uOpacity;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(dot(d, uUp), 0.0, 1.0);
          // sun elevation: low sun warms the sky toward gold/orange (Rayleigh
          // reddening through a longer atmospheric path)
          float sunElev = dot(uSun, uUp);
          float sunset = smoothstep(0.35, -0.05, sunElev);
          // deep gradient with sunset warming: zenith stays cool even at sunset,
          // horizon warms strongly
          vec3 zenith = mix(uZenith, uZenith * vec3(1.1, 0.7, 0.55), sunset * 0.4);
          vec3 horizon = mix(uHorizon, vec3(1.0, 0.62, 0.32), sunset * 0.55);
          vec3 sky = mix(horizon, zenith, pow(h, 0.42));
          // a luminous haze band hugging the horizon, brightest toward the sun
          float sunAz = max(dot(normalize(d - uUp * dot(d, uUp)), normalize(uSun - uUp * dot(uSun, uUp))), 0.0);
          float band = smoothstep(0.32, 0.0, h);
          vec3 bandCol = mix(horizon * (1.05 + 0.5 * sunAz), vec3(1.0, 0.55, 0.22), sunset * sunAz * 0.6);
          sky = mix(sky, bandCol, band * (0.5 + 0.5 * sunAz));
          // the sun: colour shifts warm at sunset
          vec3 sunTint = mix(uSunCol, vec3(1.0, 0.5, 0.18), sunset * 0.7);
          float s = max(dot(d, uSun), 0.0);
          float disc = smoothstep(0.9990, 0.99975, s);
          float glow = pow(s, 6.0) * 0.35 + pow(s, 60.0) * 0.7;
          vec3 col = sky + sunTint * (glow + disc * 3.0);
          gl_FragColor = vec4(col, uOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(120_000, 32, 16), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -90; // behind everything except the starfield
    this.mesh.visible = false;
    sm.far.add(this.mesh);
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }, skyColor: THREE.Color, density: number): void {
    if (density < 0.02) { this.mesh.visible = false; return; }
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    if (!p) { this.mesh.visible = false; return; }
    tmpUp.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    tmpSun.set(-shipPos.x, -shipPos.y, -shipPos.z).normalize(); // toward the star at origin
    const u = this.mat.uniforms;
    (u.uUp.value as THREE.Vector3).copy(tmpUp);
    (u.uSun.value as THREE.Vector3).copy(tmpSun);
    // horizon pale wash of the sky tint; zenith a deeper, richer version of it —
    // the contrast is what gives the sky atmospheric depth
    (u.uHorizon.value as THREE.Color).copy(skyColor).lerp(new THREE.Color(0xffffff), 0.45);
    (u.uZenith.value as THREE.Color).copy(skyColor).multiplyScalar(0.42);
    u.uOpacity.value = Math.min(1, density * 1.35);
    this.mesh.visible = true;
  }
}

// ---- overhead cloud deck ----------------------------------------------------

function cloudDeckTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // tileable-ish broken cloud from layered fbm
      const n = fbm2(x / S * 5, y / S * 5, 0x0cd, 5);
      const m = fbm2(x / S * 11 + 4, y / S * 11, 0x77, 4);
      let a = Math.max(0, (n * 0.7 + m * 0.5) - 0.6) * 3.0;
      a = Math.min(1, a);
      const i = (y * S + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 250;
      d[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  return tex;
}

// Several decks at different altitudes so you fly DOWN THROUGH a layered cloud
// field on the way in (and it parts below you), not one flat sheet. Each deck
// fades as you near and cross its altitude, scrolls at its own speed, and only
// shows on worlds with weather.
const CLOUD_LAYERS = [3400, 5600, 8200, 11500]; // m above the surface
const LAYER_FADE = 5200;  // each deck visible within this altitude of itself
const CLOUDY: Record<string, number> = { terran: 1, ice: 0.8, gas: 1, rocky: 0.25, barren: 0.2, lava: 0 };

export class CloudDeck {
  private decks: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; tex: THREE.CanvasTexture; alt: number }[] = [];
  private up = new THREE.Vector3();

  constructor(private sm: SceneManager) {
    for (let i = 0; i < CLOUD_LAYERS.length; i++) {
      const tex = cloudDeckTexture();
      tex.offset.set(Math.random(), Math.random());
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        roughness: 1, metalness: 0, emissive: 0x2a3240, emissiveIntensity: 0.35, opacity: 0,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(120_000, 120_000), mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = -50; // behind ships/fx, over the far sky
      sm.near.add(mesh);
      this.decks.push({ mesh, mat, tex, alt: CLOUD_LAYERS[i] });
    }
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }, time: number, density: number): void {
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    const cover = p ? (CLOUDY[p.kind] ?? 0) : 0;
    if (!p || density < 0.03 || cover <= 0) {
      for (const d of this.decks) d.mesh.visible = false;
      return;
    }
    this.up.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      const near = 1 - Math.min(1, Math.abs(atmo.altitude - d.alt) / LAYER_FADE);
      const op = Math.min(0.9, density * near * 1.25 * cover);
      d.mesh.visible = op > 0.02;
      if (!d.mesh.visible) continue;
      const rel = d.alt - atmo.altitude;
      d.mesh.position.set(this.up.x * rel, this.up.y * rel, this.up.z * rel);
      d.mesh.quaternion.setFromUnitVectors(Z, this.up);
      const sp = 0.0014 + i * 0.0006;
      d.tex.offset.set(time * sp + i * 0.37, time * sp * 0.7 - i * 0.21);
      d.mat.opacity = op;
    }
  }
}
