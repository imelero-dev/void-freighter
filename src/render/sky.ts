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
          vec3 sky = mix(uHorizon, uZenith, pow(h, 0.55));
          // hazy band right at the horizon
          sky = mix(sky, uHorizon * 1.08, smoothstep(0.18, 0.0, h));
          float s = max(dot(d, uSun), 0.0);
          float disc = smoothstep(0.9965, 0.9992, s);        // the sun's disc
          float glow = pow(s, 7.0) * 0.5 + pow(s, 120.0) * 1.2; // bloom around it
          vec3 col = sky + uSunCol * (glow + disc * 6.0);
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
    // horizon pale wash of the sky tint; zenith a deeper version of it
    (u.uHorizon.value as THREE.Color).copy(skyColor).lerp(new THREE.Color(0xffffff), 0.35);
    (u.uZenith.value as THREE.Color).copy(skyColor).multiplyScalar(0.6);
    u.uOpacity.value = Math.min(1, density * 1.2);
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

const CLOUD_ALT = 5200;   // m above the surface
const CLOUD_FADE = 26000; // start showing within this altitude of the deck

export class CloudDeck {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  private up = new THREE.Vector3();
  private tex: THREE.CanvasTexture;

  constructor(private sm: SceneManager) {
    this.tex = cloudDeckTexture();
    this.mat = new THREE.MeshStandardMaterial({
      map: this.tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      roughness: 1, metalness: 0, emissive: 0x202833, emissiveIntensity: 0.4, opacity: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(90_000, 90_000), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    sm.near.add(this.mesh);
  }

  update(system: SystemDef, shipPos: { x: number; y: number; z: number }, time: number, density: number): void {
    const atmo = atmosphereAt(system, shipPos);
    const p = atmo.planet;
    if (!p || density < 0.04 || Math.abs(atmo.altitude - CLOUD_ALT) > CLOUD_FADE) {
      this.mesh.visible = false;
      return;
    }
    this.up.set(shipPos.x - p.pos.x, shipPos.y - p.pos.y, shipPos.z - p.pos.z).normalize();
    // centre the deck over the ship at a fixed altitude above the surface
    const rel = CLOUD_ALT - atmo.altitude;
    this.mesh.position.set(this.up.x * rel, this.up.y * rel, this.up.z * rel);
    this.mesh.quaternion.setFromUnitVectors(Z, this.up);
    this.tex.offset.set(time * 0.002, time * 0.0013);
    // thickest from a touch below, fading as you climb through and above it
    const near = 1 - Math.min(1, Math.abs(atmo.altitude - CLOUD_ALT) / CLOUD_FADE);
    this.mat.opacity = Math.min(0.85, density * near * 1.1);
    this.mesh.visible = this.mat.opacity > 0.02;
  }
}
