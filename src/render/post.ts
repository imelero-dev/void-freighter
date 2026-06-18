// Post-processing chain: far pass -> near pass -> contained bloom -> gritty
// film shader (grain, vignette, chromatic aberration, scanlines). No assets.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { SceneManager } from './scene';

const GritShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    aspect: { value: 1 },
    damage: { value: 0 },   // 0..1 — red pulse when hull critical
    atmoColor: { value: new THREE.Color(0x6fa8d6) }, // sky tint inside an atmosphere
    atmoDensity: { value: 0 }, // 0..1 how deep in the air column you are
    warp: { value: 0 }, // 0..1 cruise/hyperjump warp intensity
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float aspect;
    uniform float damage;
    uniform vec3 atmoColor;
    uniform float atmoDensity;
    uniform float warp;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;

      // hyperjump warp: radial smear toward the centre stretches stars/lights
      // into speed-streaks rushing past, intensifying with cruise speed
      vec3 streak = vec3(0.0);
      if (warp > 0.001) {
        float steps = 12.0;
        for (float s = 1.0; s <= 12.0; s += 1.0) {
          float t = (s / steps) * 0.5 * warp;
          streak += texture2D(tDiffuse, uv - center * t).rgb;
        }
        streak /= steps;
      }

      // subtle chromatic aberration, stronger at the edges (amped under warp)
      float ca = 0.0022 * dot(center, center) * 4.0 + warp * 0.012;
      vec2 dir = normalize(center + 1e-6);
      float r = texture2D(tDiffuse, uv + dir * ca).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - dir * ca).b;
      vec3 col = vec3(r, g, b);
      if (warp > 0.001) {
        // bright speed lines + a tunnel darkening toward the edges
        col = max(col, streak * (0.5 + 0.8 * warp));
        col *= 1.0 - warp * 0.18 * smoothstep(0.12, 0.5, length(center));
      }

      // film grain
      float grain = hash(uv * vec2(1920.0, 1080.0) + fract(time) * 43.0) - 0.5;
      col += grain * 0.045;

      // scanlines (very faint)
      col *= 1.0 - 0.05 * (0.5 + 0.5 * sin(uv.y * 900.0));

      // atmosphere: the sky itself is drawn as the far-scene background; here we
      // just add a soft horizon brightening low on screen for depth.
      if (atmoDensity > 0.001) {
        float horizon = smoothstep(0.4, 0.05, vUv.y) * atmoDensity * 0.18;
        col = mix(col, atmoColor * 1.25, horizon);
      }

      // vignette
      float vig = smoothstep(0.95, 0.35, length(center * vec2(aspect, 1.0) * 0.9));
      col *= mix(0.72, 1.0, vig);

      // hull-critical red pulse at the edges
      if (damage > 0.001) {
        float pulse = (0.5 + 0.5 * sin(time * 7.0)) * damage;
        float edge = smoothstep(0.35, 0.85, length(center * vec2(aspect, 1.0)));
        col = mix(col, vec3(0.55, 0.04, 0.02), pulse * edge * 0.6);
      }

      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class PostPipeline {
  composer: EffectComposer;
  private grit: ShaderPass;

  constructor(private sm: SceneManager) {
    this.composer = new EffectComposer(sm.renderer);
    const farPass = new RenderPass(sm.far, sm.farCamera);
    const nearPass = new RenderPass(sm.near, sm.camera);
    nearPass.clear = false;
    nearPass.clearDepth = true;
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.55, 0.82);
    this.grit = new ShaderPass(GritShader);
    this.composer.addPass(farPass);
    this.composer.addPass(nearPass);
    this.composer.addPass(bloom);
    this.composer.addPass(this.grit);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  resize(): void {
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.grit.uniforms.aspect.value = window.innerWidth / window.innerHeight;
  }

  render(time: number, damageLevel: number, atmoColor?: THREE.Color, atmoDensity = 0, warp = 0): void {
    this.grit.uniforms.time.value = time;
    this.grit.uniforms.damage.value = damageLevel;
    if (atmoColor) (this.grit.uniforms.atmoColor.value as THREE.Color).copy(atmoColor);
    this.grit.uniforms.atmoDensity.value = atmoDensity;
    this.grit.uniforms.warp.value = warp;
    this.composer.render();
  }
}
