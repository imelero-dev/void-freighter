// Renderer + dual-scene setup. World coordinates span ~5e7 m, far beyond
// float32 precision, so we render in two layers around a floating origin:
//  - near scene: 1 unit = 1 m, everything within ~60 km of the camera
//  - far scene:  1 unit = 1 km, planets/star/station markers across the system
// Both scenes share the camera orientation; positions are camera-relative.

import * as THREE from 'three';
import type { Vec3 } from '../sim/vec';

export const FAR_SCALE = 1 / 1000;

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  near = new THREE.Scene();
  far = new THREE.Scene();
  camera: THREE.PerspectiveCamera;   // near camera (meters)
  farCamera: THREE.PerspectiveCamera; // km
  sunLightNear: THREE.DirectionalLight;
  sunLightFar: THREE.DirectionalLight;
  ambientNear: THREE.AmbientLight;
  ambientFar!: THREE.AmbientLight;
  origin: Vec3 = { x: 0, y: 0, z: 0 }; // camera world position (floating origin)

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    // real shadows in the near field: rocks shade you from the sun, your hull
    // shades the cockpit. Tight 1k map around the camera keeps it cheap.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.5, 80_000);
    this.farCamera = new THREE.PerspectiveCamera(68, 1, 0.5, 400_000);

    this.sunLightNear = new THREE.DirectionalLight(0xffd9b0, 2.6);
    this.sunLightNear.castShadow = true;
    this.sunLightNear.shadow.mapSize.set(1024, 1024);
    this.sunLightNear.shadow.camera.near = 10;
    this.sunLightNear.shadow.camera.far = 22_000;
    const sc = this.sunLightNear.shadow.camera;
    sc.left = -2200; sc.right = 2200; sc.top = 2200; sc.bottom = -2200;
    this.sunLightNear.shadow.bias = -0.0005;
    this.ambientNear = new THREE.AmbientLight(0x223344, 0.55);
    this.near.add(this.sunLightNear, this.ambientNear);

    this.sunLightFar = new THREE.DirectionalLight(0xffd9b0, 2.2);
    this.ambientFar = new THREE.AmbientLight(0x223344, 0.4);
    this.far.add(this.sunLightFar, this.ambientFar);

    this.resize();
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.farCamera.aspect = w / h;
    this.farCamera.updateProjectionMatrix();
  }

  // Live shadow toggle. three.js bakes the shadow-map state into compiled
  // shader programs, so every material in the near scene must be flagged for
  // recompilation or the change silently does nothing.
  setShadows(on: boolean): void {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.sunLightNear.castShadow = on;
    this.near.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => { m.needsUpdate = true; });
      else if (mat) mat.needsUpdate = true;
    });
    if (on) this.renderer.shadowMap.needsUpdate = true;
  }

  // Atmosphere: the empty sky becomes the far-scene background colour (so lit
  // geometry renders over a real sky, not a post wash), plus near-scene haze so
  // distant terrain fades into the air — which also hides the terrain patch edge.
  // Crucially the FAR scene is fogged too: a real daytime sky scatters so much
  // light that you can't see other planets through it — from the ground at noon
  // the rest of the system fades into the blue, reappearing only as you climb
  // back out into vacuum. Without this the far-scene planets render straight
  // over the sky background and hang there "perfectly", huge and wrong.
  private nearFog = new THREE.FogExp2(0x6fa8d6, 0);
  private farFog = new THREE.FogExp2(0x6fa8d6, 0);
  private skyBg = new THREE.Color(0x000000);
  private baseAmbient = new THREE.Color(0x223344);
  setAtmosphere(color: THREE.Color, density: number): void {
    if (density > 0.002) {
      // sky brightens from black (space) to full daylight colour at the surface
      this.skyBg.copy(color).multiplyScalar(Math.min(1, density * 1.15));
      this.far.background = this.skyBg;
      this.nearFog.color.copy(color);
      this.nearFog.density = density * density * 9e-5;
      this.near.fog = this.nearFog;
      // far-scene haze hides distant worlds in daylight. Far units are km, so a
      // density of ~7e-4 fully washes anything past ~2000 km while leaving the
      // local horizon (the planet you're on, a few hundred km of limb) visible.
      // Ramps super-linearly so a thin high-altitude haze barely dims the view
      // but the thick air at the surface buries the rest of the system.
      this.farFog.color.copy(this.skyBg);
      this.farFog.density = Math.pow(density, 1.5) * 9e-4;
      this.far.fog = this.farFog;
      // skylight: the bright sky scatters daylight onto the surface so the
      // terrain (near patch AND the far-scene planet) is lit even away from the sun
      this.ambientNear.color.copy(this.baseAmbient).lerp(color, density * 0.7);
      this.ambientNear.intensity = 0.55 + density * 1.9;
      this.ambientFar.color.copy(this.baseAmbient).lerp(color, density * 0.7);
      this.ambientFar.intensity = 0.4 + density * 1.9;
    } else {
      this.far.background = null;
      this.near.fog = null;
      this.far.fog = null;
      this.ambientNear.color.copy(this.baseAmbient);
      this.ambientNear.intensity = 0.55;
      this.ambientFar.color.copy(this.baseAmbient);
      this.ambientFar.intensity = 0.4;
    }
  }

  // dynamic FOV: widens with speed for a stronger sense of velocity
  setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 0.05) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.farCamera.fov = fov;
    this.farCamera.updateProjectionMatrix();
  }

  // Set the floating origin (camera world position) and orientation.
  setCamera(pos: Vec3, quat: THREE.Quaternion): void {
    this.origin = pos;
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(quat);
    this.farCamera.position.set(0, 0, 0);
    this.farCamera.quaternion.copy(quat);
    // light from the star (at world origin) toward the camera area.
    // DirectionalLight shines from light.position toward its target (0,0,0),
    // so the light sits on the STAR side of the camera: at +dirToStar.
    const dirToStar = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize();
    this.sunLightNear.position.set(dirToStar.x * 10_000, dirToStar.y * 10_000, dirToStar.z * 10_000);
    this.sunLightFar.position.set(dirToStar.x * 10_000, dirToStar.y * 10_000, dirToStar.z * 10_000);
  }

  // Convert a world position to near-scene local coordinates.
  toNear(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z);
  }

  // Convert a world position to far-scene (km) coordinates.
  toFar(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      (p.x - this.origin.x) * FAR_SCALE,
      (p.y - this.origin.y) * FAR_SCALE,
      (p.z - this.origin.z) * FAR_SCALE,
    );
  }

  render(): void {
    this.renderer.clear(true, true, true);
    this.renderer.render(this.far, this.farCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.near, this.camera);
  }
}
