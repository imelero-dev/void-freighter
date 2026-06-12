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

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.5, 80_000);
    this.farCamera = new THREE.PerspectiveCamera(68, 1, 0.5, 400_000);

    this.sunLightNear = new THREE.DirectionalLight(0xffd9b0, 2.6);
    this.ambientNear = new THREE.AmbientLight(0x223344, 0.55);
    this.near.add(this.sunLightNear, this.ambientNear);

    this.sunLightFar = new THREE.DirectionalLight(0xffd9b0, 2.2);
    this.far.add(this.sunLightFar, new THREE.AmbientLight(0x223344, 0.4));

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

  // Set the floating origin (camera world position) and orientation.
  setCamera(pos: Vec3, quat: THREE.Quaternion): void {
    this.origin = pos;
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(quat);
    this.farCamera.position.set(0, 0, 0);
    this.farCamera.quaternion.copy(quat);
    // light from the star (at world origin) toward the camera area
    const dir = new THREE.Vector3(-pos.x, -pos.y, -pos.z).normalize();
    // DirectionalLight shines from light.position toward target (0,0,0)
    this.sunLightNear.position.set(-dir.x * 10_000, -dir.y * 10_000, -dir.z * 10_000);
    this.sunLightFar.position.set(-dir.x * 10_000, -dir.y * 10_000, -dir.z * 10_000);
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
