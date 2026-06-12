// Game orchestrator: wires IWorld (offline or online) to render, input,
// audio and UI. One instance per play session.

import * as THREE from 'three';
import { BodiesLayer } from '../render/bodies';
import { EntitiesLayer } from '../render/entities';
import { FxLayer } from '../render/fx';
import { PostPipeline } from '../render/post';
import { SceneManager } from '../render/scene';
import { buildStarfield } from '../render/starfield';
import { GOODS } from '../sim/data';
import { vdist } from '../sim/vec';
import type { IWorld } from '../world_api';
import { ChatUi } from '../ui/chat';
import { el, fmtCredits, fmtDistance } from '../ui/dom';
import { Hud } from '../ui/hud';
import { SystemMap } from '../ui/map';
import { StationUi } from '../ui/station_windows';
import { WindowManager } from '../ui/windows';
import { AudioEngine } from './audio';
import { CameraRig } from './camera';
import { InputManager } from './input';

export class GameApp {
  private sm: SceneManager;
  private bodies: BodiesLayer;
  private entities: EntitiesLayer;
  private fx: FxLayer;
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

  onExit: (() => void) | null = null;

  constructor(private world: IWorld, canvas: HTMLCanvasElement) {
    this.sm = new SceneManager(canvas);
    this.sm.far.add(buildStarfield(world.system.seed));
    this.bodies = new BodiesLayer(this.sm, world.system);
    this.entities = new EntitiesLayer(this.sm, world);
    this.fx = new FxLayer(this.sm, world, this.entities);
    this.post = new PostPipeline(this.sm);
    this.hud = new Hud(this.sm.camera);
    this.input = new InputManager(canvas);
    this.chat = new ChatUi(() => this.world);
    this.stationUi = new StationUi(world, this.wm, this.audio);
    this.map = new SystemMap(world, this.wm, this.audio);
    this.buildContactsWindow();

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
    // rescue: H key handled as raw listener (not in the action map to keep it explicit)
    window.addEventListener('keydown', (ev) => {
      if (ev.code === 'KeyH' && !this.input.uiMode && !ev.repeat) this.world.hailRescue();
    });
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

  private toggleWindow(id: string): void {
    this.audio.click();
    this.wm.toggle(id);
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
    w.update(dt);

    // events
    for (const ev of w.drainEvents()) this.handleEvent(ev);

    const ship = w.player;
    if (ship) {
      const alpha = Math.min(1, w.renderAlpha);
      this.camera.apply(this.sm, ship, alpha, dt);
      this.entities.showPlayer = this.camera.mode === 'chase';
    }
    this.bodies.update(w.time);
    this.entities.update(w.time);
    this.fx.update(dt);

    const hullFrac = ship ? ship.hull / ship.maxHull : 1;
    const damageLevel = hullFrac < 0.25 ? (0.25 - hullFrac) * 4 : 0;
    this.post.render(w.time, Math.min(1, damageLevel));
    this.hud.draw(w, this.sm.origin, this.input.cursorX, this.input.cursorY, this.input.uiMode);
    if (this.map.isOpen) this.map.draw();

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
        if (ev.mining) {
          if (ev.fromId === w.playerId) {
            this.miningActive = true;
            this.audio.miningTick();
          }
        } else if (ev.fromId === w.playerId) {
          this.audio.laser();
        }
        break;
      case 'hit':
        if (ev.entityId === w.playerId) {
          if (ev.shield) this.audio.hitShield();
          else this.audio.hitHull();
        }
        break;
      case 'explosion':
        this.audio.explosion(ev.big);
        break;
      case 'pickup': {
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
    }
  }
}
