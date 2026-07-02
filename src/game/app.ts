// Game orchestrator: wires IWorld (offline or online) to render, input,
// audio and UI. One instance per play session.

import * as THREE from 'three';
import { BodiesLayer } from '../render/bodies';
import { buildCockpit } from '../render/cockpit';
import { DustLayer } from '../render/dust';
import { EntitiesLayer } from '../render/entities';
import { FxLayer } from '../render/fx';
import { PostPipeline } from '../render/post';
import { SceneManager } from '../render/scene';
import { buildStarfield } from '../render/starfield';
import { BOLT_SPEED, GOODS } from '../sim/data';
import { leadPoint, qrot, vdist, vnorm, vsub } from '../sim/vec';
import { settings } from '../ui/settings';
import type { IWorld } from '../world_api';
import { ChatUi } from '../ui/chat';
import { el, fmtCredits, fmtDistance } from '../ui/dom';
import { Hud } from '../ui/hud';
import { SystemMap } from '../ui/map';
import { StationUi } from '../ui/station_windows';
import { WindowManager } from '../ui/windows';
import { AudioEngine } from './audio';
import { CameraRig } from './camera';
import { bindAxis, bindButton, clearHotasBind, describeAxis, describeButton, GamepadManager } from './gamepad';
import { InputManager } from './input';
import { BINDABLE, binds, HOTAS_AXES, HOTAS_BUTTONS, keyLabel, resetBinds, setBind } from '../ui/keybinds';

export class GameApp {
  private sm: SceneManager;
  private bodies: BodiesLayer;
  private entities: EntitiesLayer;
  private fx: FxLayer;
  private dust: DustLayer;
  private cockpit: THREE.Group;
  private gamepad = new GamepadManager();
  private gpFireWas: boolean | null = null;
  private post: PostPipeline;
  private hud: Hud;
  private input: InputManager;
  private camera = new CameraRig();
  private audio = new AudioEngine();
  private wm = new WindowManager();
  private stationUi: StationUi;
  private map: SystemMap;
  private chat: ChatUi;
  private creditsHud: HTMLElement;
  private running = true;
  private lastT = performance.now();
  private uiRefreshAcc = 0;
  private wasDocked = false;
  private miningActive = false;
  private lowFuelWarned = false;
  private wasAligned = false;
  private fovCurrent = 68;
  private alarmUntil = 0;   // hull klaxon bursts on damage, then shuts up
  private headlight!: THREE.SpotLight;
  private headlightOn = false;

  onExit: (() => void) | null = null;

  constructor(private world: IWorld, canvas: HTMLCanvasElement) {
    this.sm = new SceneManager(canvas);
    this.sm.far.add(buildStarfield(world.system.seed));
    this.bodies = new BodiesLayer(this.sm, world.system);
    this.entities = new EntitiesLayer(this.sm, world);
    this.fx = new FxLayer(this.sm, world, this.entities);
    this.dust = new DustLayer(this.sm, world);
    // first-person cockpit interior rides on the camera
    this.sm.near.add(this.sm.camera);
    // headlights: a hard forward beam from the nose. Physical falloff
    // (decay 2) needs candela-scale intensity to read against the sun —
    // this is ~8x sunlight at 500 m and still ~half sunlight at 2 km.
    this.headlight = new THREE.SpotLight(0xfff2d8, 5e6, 6500, 0.42, 0.45, 2);
    this.headlight.position.set(0, -1, -10); // ahead of the cockpit glass so the dash doesn't blow out
    this.headlight.target.position.set(0, -6, -900);
    this.headlight.visible = false;
    this.sm.camera.add(this.headlight);
    this.sm.camera.add(this.headlight.target);
    this.cockpit = buildCockpit();
    this.cockpit.scale.setScalar(2.2); // keeps geometry past the near plane
    this.cockpit.position.y = 0.28;    // dashboard peeks into the lower view
    this.sm.camera.add(this.cockpit);
    this.post = new PostPipeline(this.sm);
    this.hud = new Hud(this.sm.camera);
    this.input = new InputManager(canvas);
    this.chat = new ChatUi(() => this.world);
    this.stationUi = new StationUi(world, this.wm, this.audio);
    this.map = new SystemMap(world, this.wm, this.audio);
    this.buildContactsWindow();
    this.buildControlsWindow();

    this.creditsHud = el('div', 'vf-credits-hud');
    document.body.appendChild(this.creditsHud);

    this.bindInput();
    this.hud.resize();
    window.addEventListener('resize', this.onResize);
    this.audio.ensure();
    this.hud.pushLog('Systems online. Fly safe out there.', '#8fb');
    this.hud.pushLog('F1 — flight manual. M — system chart.', '#8a8d90');
    this.frame();
  }

  private onResize = () => {
    this.sm.resize();
    this.post.resize();
    this.hud.resize();
  };

  destroy(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
  }

  // -------------------------------------------------------------------------

  private bindInput(): void {
    const w = this.world;
    const input = this.input;
    input.on('toggleCruise', () => w.toggleCruise());
    input.on('zeroThrottle', () => input.zeroThrottle());
    input.on('toggleAssist', () => w.toggleFlightAssist());
    input.on('toggleDrill', () => w.setDrill(!w.drillOn));
    input.on('toggleLights', () => {
      this.headlightOn = !this.headlightOn;
      this.audio.click();
      this.hud.pushLog(`Headlights ${this.headlightOn ? 'ON' : 'OFF'}.`, '#8ad');
    });
    input.on('dock', () => {
      if (w.player?.dockedAt) {
        this.wm.closeAll();
        w.undock();
      } else {
        w.requestDock();
      }
    });
    input.on('tab', () => w.tabTarget());
    input.on('targetReticle', () => w.targetReticle());
    input.onFire((on) => w.setFiring(on));
    input.onMissile(() => w.fireMissile());
    input.on('map', () => this.toggleWindow('map'));
    input.on('cargo', () => this.toggleWindow('cargo'));
    input.on('ship', () => this.toggleWindow('shipyard'));
    input.on('journal', () => this.toggleWindow('journal'));
    input.on('market', () => this.toggleWindow('market'));
    input.on('contacts', () => this.toggleWindow('contacts'));
    input.on('help', () => this.menuHelp?.());
    input.on('chat', () => {
      if (!this.chat.open) {
        this.chat.openInput();
        this.input.uiMode = true;
        this.input.releasePointer();
      }
    });
    input.on('setDestination', () => {
      if (w.destination) {
        w.setDestination(null);
        this.hud.pushLog('Destination cleared.', '#8a8d90');
        return;
      }
      const sel = this.map.externalSelect();
      const ship = w.player;
      const target = ship?.targetId != null ? w.entities.get(ship.targetId) : null;
      if (target) {
        w.setDestination({ kind: 'point', id: '', name: target.name, pos: { ...target.pos } });
        this.hud.pushLog(`Destination: ${target.name}`, '#d9a441');
      } else if (sel) {
        w.setDestination({ kind: sel.kind, id: sel.id, name: sel.name, pos: { ...sel.pos } });
        this.hud.pushLog(`Destination: ${sel.name}`, '#d9a441');
      }
    });
    input.on('escape', () => {
      if (this.chat.open) {
        this.chat.closeInput();
        this.input.uiMode = false;
        return;
      }
      if (!this.wm.closeTop()) {
        this.onExit?.();
      }
    });
    input.on('toggleCamera', () => {
      this.camera.toggle();
      this.hud.cameraMode = this.camera.mode;
    });
    input.on('rescue', () => w.hailRescue());
    input.on('controls', () => this.toggleWindow('controls'));
    this.chat.onOpenChange = (open) => {
      this.input.uiMode = open || this.wm.anyOpen();
    };
    this.wm.onChange = () => {
      const any = this.wm.anyOpen();
      this.input.uiMode = any || this.chat.open;
      if (any) this.input.releasePointer();
    };
  }

  menuHelp: (() => void) | null = null;

  applySettings(): void {
    this.audio.applyVolume();
  }

  private assistLevel = 0; // smoothed aim-assist strength (no jerky grabs)

  // Optional aim assist: subtle magnetism toward the locked hostile's
  // intercept point. Three rules keep it from fighting the player:
  //  - narrow cone (8°): it polishes your aim, it never acquires for you
  //  - strength fades to zero as soon as you move the mouse yourself
  //  - smoothed over time, so it eases in/out instead of snatching the nose
  private applyAimAssist(w: IWorld, dt: number): void {
    const decay = () => {
      this.assistLevel = Math.max(0, this.assistLevel - dt * 6);
    };
    if (!settings.aimAssist || this.input.uiMode) return decay();
    const ship = w.player;
    if (!ship || ship.dockedAt || ship.cruise !== 'off') return decay();
    const target = ship.targetId !== null ? w.entities.get(ship.targetId) : null;
    if (!target || target.dead || target.kind !== 'ship' || !target.pirate) return decay();
    const d = vdist(ship.pos, target.pos);
    if (d > w.shipStats.weaponRange * 1.2) return decay();

    const aim = leadPoint(ship.pos, ship.vel, target.pos, target.vel, BOLT_SPEED);
    const qc = { x: -ship.orient.x, y: -ship.orient.y, z: -ship.orient.z, w: ship.orient.w };
    const local = qrot(qc, vnorm(vsub(aim, ship.pos)));
    const yawErr = Math.atan2(-local.x, -local.z);
    const pitchErr = Math.atan2(local.y, -local.z);
    const ang = Math.hypot(yawErr, pitchErr);
    const CONE = 0.14;
    // the player's own stick input dominates: any deliberate movement mutes
    // the assist almost entirely
    const userMag = Math.min(1, Math.hypot(w.input.yaw, w.input.pitch) * 2.5);
    const targetLevel = ang < CONE ? 0.35 * (1 - ang / CONE) * (1 - userMag) : 0;
    this.assistLevel += (targetLevel - this.assistLevel) * Math.min(1, dt * 8);
    if (this.assistLevel < 0.01) return;
    // convert angular error into a small rate command, capped well below
    // full stick authority
    const k = 5;
    w.input.yaw = clampInput(w.input.yaw + clampInput(yawErr * k) * this.assistLevel);
    w.input.pitch = clampInput(w.input.pitch + clampInput(pitchErr * k) * this.assistLevel);
  }

  private toggleWindow(id: string): void {
    this.audio.click();
    this.wm.toggle(id);
  }

  // Derelict story prompt: short creepy log + breach-or-leave choice.
  private openDerelictWindow(entityId: number, name: string, story: string): void {
    const win = this.wm.register(`derelict_${entityId}`, name.toUpperCase());
    win.body.appendChild(el('div', 'vf-derelict-story', story));
    win.body.appendChild(el('div', 'vf-subline', 'The cargo hold is still sealed. The cutting torch is in the locker.'));
    const row = el('div', 'vf-menu-row');
    const breach = el('button', 'vf-btn big danger');
    breach.textContent = 'BREACH THE HOLD';
    breach.addEventListener('click', () => {
      this.audio.click();
      this.world.openDerelict(entityId);
      this.wm.close(`derelict_${entityId}`);
    });
    const leave = el('button', 'vf-btn big');
    leave.textContent = 'LEAVE IT BE';
    leave.addEventListener('click', () => {
      this.audio.click();
      this.wm.close(`derelict_${entityId}`);
      this.hud.pushLog('Some doors are better left shut.', '#8a8d90');
    });
    row.appendChild(breach);
    row.appendChild(leave);
    win.body.appendChild(row);
    win.refresh = () => {};
    this.wm.show(`derelict_${entityId}`);
    this.input.releasePointer();
  }

  // Controls window (F2): keyboard rebinding + HOTAS axis/button capture.
  private buildControlsWindow(): void {
    const win = this.wm.register('controls', 'CONTROLS & HOTAS', true);
    let capturing: string | null = null;
    win.refresh = () => {
      while (win.body.firstChild) win.body.removeChild(win.body.firstChild);

      // --- keyboard ---
      win.body.appendChild(el('div', 'vf-section-title', '— KEYBOARD (click REBIND, then press a key · Esc cancels) —'));
      const grid = el('div', 'vf-binds');
      for (const def of BINDABLE) {
        grid.appendChild(el('span', 'vf-bind-label', def.label));
        grid.appendChild(el('span', 'vf-bind-key', capturing === def.id ? 'PRESS A KEY…' : keyLabel(binds[def.id])));
        const btn = el('button', 'vf-mini');
        btn.textContent = 'REBIND';
        btn.addEventListener('click', () => {
          this.audio.click();
          capturing = def.id;
          win.refresh();
          const onKey = (ev: KeyboardEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            window.removeEventListener('keydown', onKey, true);
            if (ev.code !== 'Escape') setBind(def.id, ev.code);
            capturing = null;
            win.refresh();
          };
          window.addEventListener('keydown', onKey, true);
        });
        grid.appendChild(btn);
      }
      win.body.appendChild(grid);
      const resetBtn = el('button', 'vf-btn danger');
      resetBtn.textContent = 'RESET DEFAULTS';
      resetBtn.addEventListener('click', () => {
        this.audio.click();
        resetBinds();
        win.refresh();
      });
      win.body.appendChild(resetBtn);

      // --- HOTAS / gamepad ---
      win.body.appendChild(el('div', 'vf-section-title', '— HOTAS / GAMEPAD —'));
      win.body.appendChild(el('div', 'vf-subline',
        this.gamepad.deviceName ? `Device: ${this.gamepad.deviceName}` : 'No device detected — press any button on it to wake it up.'));
      const hgrid = el('div', 'vf-binds');
      for (const ax of HOTAS_AXES) {
        hgrid.appendChild(el('span', 'vf-bind-label', ax.label));
        hgrid.appendChild(el('span', 'vf-bind-key', capturing === `ax_${ax.id}` ? 'MOVE THE AXIS…' : describeAxis(ax.id)));
        const cell = el('span', 'vf-bind-actions');
        const bindBtn = el('button', 'vf-mini');
        bindBtn.textContent = 'BIND';
        bindBtn.addEventListener('click', () => {
          this.audio.click();
          capturing = `ax_${ax.id}`;
          win.refresh();
          this.gamepad.captureAxis((index, invert) => {
            bindAxis(ax.id, index, invert);
            capturing = null;
            win.refresh();
          });
        });
        const clearBtn = el('button', 'vf-mini sell');
        clearBtn.textContent = '✕';
        clearBtn.addEventListener('click', () => {
          clearHotasBind('axis', ax.id);
          win.refresh();
        });
        cell.appendChild(bindBtn);
        cell.appendChild(clearBtn);
        hgrid.appendChild(cell);
      }
      for (const bt of HOTAS_BUTTONS) {
        hgrid.appendChild(el('span', 'vf-bind-label', bt.label));
        hgrid.appendChild(el('span', 'vf-bind-key', capturing === `bt_${bt.id}` ? 'PRESS A BUTTON…' : describeButton(bt.id)));
        const cell = el('span', 'vf-bind-actions');
        const bindBtn = el('button', 'vf-mini');
        bindBtn.textContent = 'BIND';
        bindBtn.addEventListener('click', () => {
          this.audio.click();
          capturing = `bt_${bt.id}`;
          win.refresh();
          this.gamepad.captureButton((index) => {
            bindButton(bt.id, index);
            capturing = null;
            win.refresh();
          });
        });
        const clearBtn = el('button', 'vf-mini sell');
        clearBtn.textContent = '✕';
        clearBtn.addEventListener('click', () => {
          clearHotasBind('button', bt.id);
          win.refresh();
        });
        cell.appendChild(bindBtn);
        cell.appendChild(clearBtn);
        hgrid.appendChild(cell);
      }
      win.body.appendChild(hgrid);
      win.body.appendChild(el('div', 'vf-stats',
        'Tip: bind pitch/yaw to your stick and throttle to the slider — the mouse keeps working in parallel. ' +
        'Axis capture auto-detects direction; use ✕ and re-bind moving the other way to flip it.'));
    };
    win.onClose = () => {
      this.gamepad.cancelCapture();
    };
  }

  private buildContactsWindow(): void {
    const win = this.wm.register('contacts', 'CONTACTS');
    win.refresh = () => {
      while (win.body.firstChild) win.body.removeChild(win.body.firstChild);
      const ship = this.world.player;
      if (!ship) return;
      const stats = this.world.shipStats;
      const rows: Array<{ d: number; node: HTMLElement }> = [];
      for (const e of this.world.entities.values()) {
        if (e.id === this.world.playerId || e.dead) continue;
        const d = vdist(e.pos, ship.pos);
        if (d > stats.sensorRange) continue;
        const resolved = d < stats.resolveRange;
        const row = el('div', 'vf-row contact');
        const label = !resolved && e.kind === 'ship' ? 'UNRESOLVED SIGNATURE'
          : e.kind === 'ship' ? `${e.name}${e.pirate ? ' ☠' : ''}`
            : e.kind === 'asteroid' ? `${e.rockType} asteroid`
              : e.kind === 'loot' ? 'salvage container'
                : e.kind === 'fragment' ? `ore fragment (${e.goodId ? GOODS[e.goodId].name : '?'})` : e.kind;
        const cls = e.kind === 'ship' ? (resolved ? (e.pirate ? 'hostile' : 'friendly') : 'unknown') : '';
        row.appendChild(el('span', `vf-cell name ${cls}`, label));
        row.appendChild(el('span', 'vf-cell num', fmtDistance(d)));
        const b = el('button', 'vf-mini', 'TARGET');
        b.addEventListener('click', () => {
          this.world.setTarget(e.id);
          this.audio.click();
        });
        row.appendChild(b);
        rows.push({ d, node: row });
      }
      rows.sort((a, b) => a.d - b.d);
      if (rows.length === 0) win.body.appendChild(el('div', 'vf-empty', 'No contacts in sensor range. Just you and the dark.'));
      for (const r of rows.slice(0, 30)) win.body.appendChild(r.node);
    };
  }

  // -------------------------------------------------------------------------

  private frame = () => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const now = performance.now();
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.25) dt = 0.25;

    const w = this.world;
    this.input.frame(dt, w.input);
    // E2E bot override: scripts write window.VF.botInput instead of fighting
    // the InputManager for w.input
    const botInput = (window as any).VF?.botInput;
    if (botInput) Object.assign(w.input, botInput);
    // HOTAS / gamepad layer
    const gpFrame = this.gamepad.apply(w.input, (v) => {
      this.input.throttle = v;
    });
    for (const action of gpFrame.actions) this.input.trigger(action);
    if (gpFrame.missile) w.fireMissile();
    if (gpFrame.fire !== null && gpFrame.fire !== this.gpFireWas) {
      w.setFiring(gpFrame.fire);
    }
    this.gpFireWas = gpFrame.fire;
    this.applyAimAssist(w, dt);
    w.update(dt);

    // events
    for (const ev of w.drainEvents()) this.handleEvent(ev);

    const ship = w.player;
    if (ship) {
      const alpha = Math.min(1, w.renderAlpha);
      this.camera.apply(this.sm, ship, alpha, dt);
      this.entities.showPlayer = this.camera.mode === 'chase';
      this.cockpit.visible = this.camera.mode === 'cockpit' && !ship.dockedAt;
      // speed-based FOV: subtle at maneuver, pronounced under cruise
      const speed = Math.hypot(ship.vel.x, ship.vel.y, ship.vel.z);
      const maneuverKick = Math.min(1.1, speed / Math.max(1, w.shipStats.maxSpeed)) * 6;
      const cruiseKick = ship.cruise === 'cruise' ? Math.min(1, ship.cruiseSpeed / w.shipStats.cruiseMax) * 10 + 3 : 0;
      const turboKick = w.turboActive ? 6 + (speed / 1000) * 8 : 0;
      this.fovCurrent += (68 + Math.max(maneuverKick, cruiseKick, turboKick) - this.fovCurrent) * Math.min(1, dt * 4);
      this.sm.setFov(this.fovCurrent);
    }
    this.headlight.visible = this.headlightOn && !!ship && !ship.dockedAt;
    this.bodies.update(w.time);
    this.entities.update(w.time);
    this.fx.update(dt);
    this.dust.update();

    const hullFrac = ship ? ship.hull / ship.maxHull : 1;
    const damageLevel = hullFrac < 0.25 ? (0.25 - hullFrac) * 4 : 0;
    this.post.render(w.time, Math.min(1, damageLevel));
    this.hud.draw(w, this.sm.origin, this.input.cursorX, this.input.cursorY, this.input.uiMode);
    if (this.map.isOpen) this.map.draw();

    // GPS alignment snap tone (rising edge only)
    if (this.hud.destAligned && !this.wasAligned) this.audio.alignSnap();
    this.wasAligned = this.hud.destAligned;

    // credits readout
    this.creditsHud.textContent = `${fmtCredits(w.profile.credits)}${w.online ? (w.connected ? ' · ONLINE' : ' · RECONNECTING…') : ''}`;

    // dock state transitions
    const docked = !!ship?.dockedAt;
    if (docked && !this.wasDocked) {
      this.stationUi.updateDockBar();
      this.input.releasePointer();
      this.input.zeroThrottle();
      this.wm.show('market');
    } else if (!docked && this.wasDocked) {
      this.stationUi.hideDockBar();
      this.wm.closeAll();
    } else if (docked) {
      this.stationUi.updateDockBar();
    }
    this.wasDocked = docked;

    // periodic UI refresh of open windows
    this.uiRefreshAcc += dt;
    if (this.uiRefreshAcc > 0.5) {
      this.uiRefreshAcc = 0;
      this.wm.refreshOpen();
      // low fuel beep
      if (ship && !docked) {
        const fuelFrac = w.profile.fuel / w.shipStats.fuelMax;
        if (fuelFrac < 0.15 && !this.lowFuelWarned) {
          this.lowFuelWarned = true;
          this.audio.alarmFuel();
          this.hud.flashAlert('FUEL LOW', '#e8402a');
        }
        if (fuelFrac > 0.3) this.lowFuelWarned = false;
        if (w.profile.fuel <= 0.5) {
          this.hud.flashAlert('FUEL EMPTY — [H] HAIL RESCUE TOW', '#e8402a', 600);
        }
      }
    }

    // audio state
    if (ship) {
      this.audio.setState({
        throttle: ship.throttle,
        cruise: ship.cruise,
        cruiseFrac: ship.cruiseSpeed / Math.max(1, w.shipStats.cruiseMax),
        docked,
        hullFrac,
        mining: this.miningActive,
        dead: false,
        turbo: w.turboActive,
        alarm: performance.now() < this.alarmUntil,
      });
    }
    this.miningActive = false; // re-set by mining laser events each tick
  };

  private handleEvent(ev: import('../sim/types').SimEvent): void {
    const w = this.world;
    this.fx.handleEvents([ev]);
    switch (ev.type) {
      case 'log':
        this.hud.pushLog(ev.text, ev.color ?? '#d9a441');
        break;
      case 'laser':
        if (ev.mining && ev.fromId === w.playerId) {
          this.miningActive = true;
          this.audio.miningTick();
        }
        break;
      case 'shot': {
        if (ev.entityId === w.playerId) {
          this.audio.laser(true);
        } else {
          const ship = w.player;
          if (ship && Math.hypot(ev.x - ship.pos.x, ev.y - ship.pos.y, ev.z - ship.pos.z) < 2800) {
            this.audio.laser(false);
          }
        }
        break;
      }
      case 'hit': {
        if (ev.entityId === w.playerId) {
          if (ev.shield) this.audio.hitShield();
          else this.audio.hitHull();
          // hull-critical klaxon: a 3.5 s burst per fresh hit, not a loop
          const p = w.player;
          if (!ev.shield && p && p.hull / p.maxHull < 0.3) {
            this.alarmUntil = performance.now() + 3500;
          }
          // incoming-fire direction warning
          if (ev.fx !== undefined && w.player) {
            this.hud.addDamageDir({ x: ev.fx, y: ev.fy!, z: ev.fz! }, w.player.pos);
          }
        } else if (ev.amount > 0) {
          // floating combat text over whatever we (or someone) hit
          this.hud.pushFloater({ x: ev.x, y: ev.y, z: ev.z }, `-${ev.amount}`, ev.shield ? '#7fb1c9' : '#d9a441');
        }
        break;
      }
      case 'explosion':
        this.audio.explosion(ev.big);
        break;
      case 'fragment': {
        // ore chunk cracked off a rock nearby
        const ship = w.player;
        if (ship && Math.hypot(ev.x - ship.pos.x, ev.y - ship.pos.y, ev.z - ship.pos.z) < 1500) {
          this.audio.oreChip();
        }
        break;
      }
      case 'pickup': {
        if (ev.credits === 0 && ev.good) {
          // mined ore scooped into the hold: distinct stash feedback (#10)
          this.audio.oreStash();
          this.hud.pushLog(`+${ev.qty}× ${GOODS[ev.good]?.name ?? ev.good} → hold`, '#7fc97f');
          break;
        }
        this.audio.pickup();
        const bits: string[] = [];
        if (ev.credits > 0) bits.push(fmtCredits(ev.credits));
        if (ev.good && ev.qty > 0) bits.push(`${ev.qty}× ${GOODS[ev.good]?.name ?? ev.good}`);
        if (bits.length) this.hud.pushLog(`Recovered: ${bits.join(' + ')}`, '#7fc97f');
        break;
      }
      case 'docked': {
        this.audio.dockThunk();
        const st = w.system.stations.find((s) => s.id === ev.stationId);
        this.hud.pushLog(`Docked at ${st?.name ?? ev.stationId}. Shields charging.`, '#8fb');
        break;
      }
      case 'undocked':
        this.audio.undockHiss();
        this.hud.pushLog('Undocked. You are on your own again.', '#8a8d90');
        break;
      case 'tx':
        this.audio.kaching();
        this.hud.pushLog(`${ev.bought ? 'Bought' : 'Sold'} ${ev.qty}× ${GOODS[ev.good]?.name ?? ev.good} — ${fmtCredits(ev.total)}`, ev.bought ? '#d9a441' : '#7fc97f');
        break;
      case 'refined':
        this.audio.kaching();
        this.hud.pushLog(`Refined ${ev.qtyIn}× ${GOODS[ev.goodIn].name} → ${ev.qtyOut}× ${GOODS[ev.goodOut].name}`, '#7fc97f');
        break;
      case 'contractDone':
        this.audio.fanfare();
        this.hud.pushLog(`CONTRACT COMPLETE — ${fmtCredits(ev.reward)}`, '#7fc97f');
        break;
      case 'contractFailed':
        this.audio.deny();
        this.hud.pushLog(`Contract failed: ${ev.desc}`, '#e8402a');
        break;
      case 'lockWarning':
        this.audio.lockWarning();
        this.hud.flashAlert('⚠ MISSILE LOCK ⚠');
        break;
      case 'hostileDetected':
        this.audio.hostileDetected();
        this.hud.flashAlert('HOSTILE CONTACT', '#e8402a');
        break;
      case 'interdiction':
        this.audio.interdiction();
        this.hud.flashAlert('INTERDICTION — CRUISE DROPPED', '#e8402a', 3200);
        break;
      case 'death':
        this.hud.flashAlert('SHIP DESTROYED', '#e8402a', 5000);
        this.hud.pushLog(`Insurance recovered your hull. Cargo lost: ${ev.lostCargo} units. Deductible: ${fmtCredits(ev.deductible)}.`, '#e8402a');
        this.input.zeroThrottle();
        break;
      case 'chat':
        this.chat.addMessage(ev.from, ev.text, ev.channel);
        break;
      case 'comms':
        this.hud.setComms(ev.text);
        this.audio.commsStatic();
        break;
      case 'econ':
        this.hud.pushLog(`NEWS: ${ev.headline}`, '#7fb1c9');
        break;
      case 'rescue':
        this.hud.pushLog(`Rescue tow inbound (${fmtCredits(ev.cost)}). Sit tight.`, '#8fb');
        break;
      case 'fine':
        this.audio.deny();
        this.hud.pushLog(`CUSTOMS: ${ev.desc} — fined ${fmtCredits(ev.amount)}.`, '#e8402a');
        break;
      case 'cruiseChange':
        if (ev.entityId === w.playerId && ev.state === 'cruise') {
          this.hud.pushLog('Cruise drive engaged.', '#8fb');
        }
        break;
      case 'forcefield':
        this.audio.deny();
        this.audio.alarmFuel();
        this.hud.flashAlert(`PLANETARY EXCLUSION FIELD — ${ev.body.toUpperCase()} — TURN BACK`, '#e8402a', 3000);
        break;
      case 'derelict':
        this.audio.commsStatic();
        this.openDerelictWindow(ev.entityId, ev.name, ev.story);
        break;
    }
  }
}

function clampInput(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
