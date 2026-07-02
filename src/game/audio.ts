// All sound synthesized at runtime with WebAudio. No audio files.
// Continuous layers (engine, life support, station ambience, alarm, mining)
// are persistent nodes whose gains track game state; one-shots build small
// node graphs on demand.

import { settings } from '../ui/settings';

const MASTER_BASE = 0.55;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;

  // continuous layer gains
  private engineGain!: GainNode;
  private engineOsc!: OscillatorNode;
  private cruiseGain!: GainNode;
  private lifeGain!: GainNode;
  private stationGain!: GainNode;
  private alarmGain!: GainNode;
  private miningGain!: GainNode;
  private alarmTimer = 0;

  muted = false;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_BASE * settings.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- engine hum ---
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 160;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 48;
    const engineOsc2 = ctx.createOscillator();
    engineOsc2.type = 'sawtooth';
    engineOsc2.frequency.value = 51.7;
    this.engineOsc.connect(engineFilter);
    engineOsc2.connect(engineFilter);
    engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    engineOsc2.start();

    // --- cruise whoosh ---
    this.cruiseGain = ctx.createGain();
    this.cruiseGain.gain.value = 0;
    const whoosh = this.loopNoise();
    const whooshFilter = ctx.createBiquadFilter();
    whooshFilter.type = 'bandpass';
    whooshFilter.frequency.value = 320;
    whooshFilter.Q.value = 0.6;
    whoosh.connect(whooshFilter);
    whooshFilter.connect(this.cruiseGain);
    this.cruiseGain.connect(this.master);

    // --- life support (the sound of not being dead) ---
    this.lifeGain = ctx.createGain();
    this.lifeGain.gain.value = 0;
    const air = this.loopNoise();
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 230;
    air.connect(airFilter);
    airFilter.connect(this.lifeGain);
    this.lifeGain.connect(this.master);

    // --- station ambience ---
    this.stationGain = ctx.createGain();
    this.stationGain.gain.value = 0;
    const crowd = this.loopNoise();
    const crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'lowpass';
    crowdFilter.frequency.value = 420;
    const hum = ctx.createOscillator();
    hum.type = 'triangle';
    hum.frequency.value = 117;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.18;
    crowd.connect(crowdFilter);
    crowdFilter.connect(this.stationGain);
    hum.connect(humGain);
    humGain.connect(this.stationGain);
    hum.start();
    this.stationGain.connect(this.master);

    // --- low hull alarm (two-tone) ---
    this.alarmGain = ctx.createGain();
    this.alarmGain.gain.value = 0;
    const alarmOsc = ctx.createOscillator();
    alarmOsc.type = 'square';
    alarmOsc.frequency.value = 520;
    const alarmLfo = ctx.createOscillator();
    alarmLfo.type = 'square';
    alarmLfo.frequency.value = 2.4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    alarmLfo.connect(lfoGain);
    lfoGain.connect(alarmOsc.frequency);
    const alarmFilter = ctx.createBiquadFilter();
    alarmFilter.type = 'lowpass';
    alarmFilter.frequency.value = 900;
    alarmOsc.connect(alarmFilter);
    alarmFilter.connect(this.alarmGain);
    this.alarmGain.connect(this.master);
    alarmOsc.start();
    alarmLfo.start();

    // --- mining beam drone ---
    this.miningGain = ctx.createGain();
    this.miningGain.gain.value = 0;
    const mOsc = ctx.createOscillator();
    mOsc.type = 'sawtooth';
    mOsc.frequency.value = 86;
    const mTrem = ctx.createOscillator();
    mTrem.frequency.value = 13;
    const mTremGain = ctx.createGain();
    mTremGain.gain.value = 0.35;
    const mLevel = ctx.createGain();
    mLevel.gain.value = 0.65;
    mTrem.connect(mTremGain);
    mTremGain.connect(mLevel.gain);
    const mFilter = ctx.createBiquadFilter();
    mFilter.type = 'lowpass';
    mFilter.frequency.value = 300;
    mOsc.connect(mFilter);
    mFilter.connect(mLevel);
    mLevel.connect(this.miningGain);
    this.miningGain.connect(this.master);
    mOsc.start();
    mTrem.start();
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start();
    return src;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyVolume();
    return this.muted;
  }

  // re-read the volume setting (called live from the settings sliders)
  applyVolume(): void {
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_BASE * settings.volume;
  }

  // Per-frame state tracking. All values already smoothed by setTargetAtTime.
  setState(s: {
    throttle: number; cruise: 'off' | 'charging' | 'cruise'; cruiseFrac: number;
    docked: boolean; hullFrac: number; mining: boolean; dead: boolean; turbo: boolean;
    alarm: boolean;
  }): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const ramp = (g: GainNode, v: number, tc = 0.25) => g.gain.setTargetAtTime(v, t, tc);
    const flying = !s.docked;
    ramp(this.engineGain, flying ? 0.05 + Math.abs(s.throttle) * 0.16 + (s.turbo ? 0.1 : 0) : 0.015);
    this.engineOsc.frequency.setTargetAtTime(
      flying ? 48 + Math.abs(s.throttle) * 40 + (s.cruise === 'cruise' ? 35 : 0) + (s.turbo ? 55 : 0) : 36, t, 0.3);
    ramp(this.cruiseGain, s.cruise === 'cruise' ? 0.10 + s.cruiseFrac * 0.16 : s.cruise === 'charging' ? 0.06 : s.turbo ? 0.08 : 0);
    ramp(this.lifeGain, flying ? 0.035 : 0);
    ramp(this.stationGain, s.docked ? 0.13 : 0, 0.8);
    // alarm is event-driven (bursts on new damage), not a constant siren —
    // a permanent klaxon just trains the player to mute the game
    ramp(this.alarmGain, flying && s.alarm && !s.dead ? 0.07 : 0, 0.05);
    ramp(this.miningGain, s.mining ? 0.17 : 0, 0.08);
  }

  // ------------------------------------------------------------------
  // One-shots
  // ------------------------------------------------------------------

  private blip(freqFrom: number, freqTo: number, dur: number, type: OscillatorType, gain: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noiseBurst(filterType: BiquadFilterType, freqFrom: number, freqTo: number, dur: number, gain: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freqFrom, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  laser(own = true): void {
    this.blip(900, 240, 0.09, 'square', own ? 0.08 : 0.03);
  }

  miningTick(): void {
    // handled by the continuous drone; occasional crackle
    if (Math.random() < 0.1) this.noiseBurst('bandpass', 700, 300, 0.06, 0.03);
  }

  // a chunk of ore cracks off the rock
  oreChip(): void {
    this.noiseBurst('bandpass', 1600, 400, 0.09, 0.06);
    this.blip(420, 180, 0.07, 'triangle', 0.05);
  }

  // ore secured in the hold: a short satisfied clunk-chime
  oreStash(): void {
    this.noiseBurst('lowpass', 500, 150, 0.08, 0.08);
    this.blip(660, 660, 0.06, 'sine', 0.07);
    setTimeout(() => this.blip(990, 990, 0.09, 'sine', 0.06), 60);
  }

  hitShield(): void {
    this.blip(1300, 700, 0.12, 'sine', 0.1);
    this.noiseBurst('highpass', 2500, 1200, 0.08, 0.05);
  }

  hitHull(): void {
    this.noiseBurst('lowpass', 380, 90, 0.18, 0.22);
    this.blip(120, 55, 0.16, 'triangle', 0.18);
  }

  explosion(big: boolean): void {
    this.noiseBurst('lowpass', big ? 900 : 600, 50, big ? 1.4 : 0.7, big ? 0.5 : 0.3);
    this.blip(80, 28, big ? 1.2 : 0.6, 'sine', big ? 0.4 : 0.22);
  }

  lockWarning(): void {
    if (!this.ctx) return;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.blip(1500, 1500, 0.05, 'square', 0.07), i * (160 - i * 22));
    }
  }

  hostileDetected(): void {
    this.blip(140, 320, 1.4, 'sawtooth', 0.06);
  }

  dockThunk(): void {
    this.noiseBurst('lowpass', 240, 70, 0.3, 0.2);
    this.blip(90, 45, 0.4, 'sine', 0.25);
  }

  undockHiss(): void {
    this.noiseBurst('bandpass', 1400, 500, 0.5, 0.08);
  }

  click(): void {
    this.blip(2200, 1600, 0.03, 'square', 0.04);
  }

  deny(): void {
    this.blip(300, 180, 0.12, 'square', 0.06);
  }

  kaching(): void {
    this.blip(1320, 1320, 0.07, 'sine', 0.1);
    setTimeout(() => this.blip(1760, 1760, 0.12, 'sine', 0.1), 70);
  }

  fanfare(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => this.blip(f, f, 0.18, 'triangle', 0.09), i * 110));
  }

  pickup(): void {
    this.blip(740, 1180, 0.08, 'sine', 0.07);
  }

  commsStatic(): void {
    if (!this.ctx) return;
    // garbled radio: a few modulated noise bursts
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.noiseBurst('bandpass', 900 + Math.random() * 900, 600, 0.1 + Math.random() * 0.18, 0.035), i * 220 + Math.random() * 80);
    }
  }

  alignSnap(): void {
    this.blip(880, 1240, 0.12, 'sine', 0.05);
  }

  alarmFuel(): void {
    this.blip(620, 620, 0.25, 'square', 0.07);
    setTimeout(() => this.blip(470, 470, 0.3, 'square', 0.07), 300);
  }

  interdiction(): void {
    this.noiseBurst('lowpass', 1200, 100, 0.9, 0.25);
    this.blip(220, 60, 0.8, 'sawtooth', 0.2);
  }
}
