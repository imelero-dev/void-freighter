// Main menu + help overlay. Shown before play and on Escape.

import { OfflineWorld } from '../offline_world';
import { button, el } from './dom';

export interface MenuCallbacks {
  startOffline(pilotName: string, fresh: boolean): void;
  startOnline(username: string, password: string, register: boolean): Promise<void>;
  resume(): void;
}

const CONTROLS: Array<[string, string]> = [
  ['Shift / W', 'throttle up (gradual)'], ['Ctrl / S', 'throttle down — hold past zero to brake'],
  ['Caps Lock', 'cruise drive — "hypervelocity"'], ['X', 'cut throttle'],
  ['A / D', 'strafe left / right'], ['R / F', 'strafe up / down'], ['Q / E', 'roll'],
  ['mouse', 'pitch / yaw'], ['Z', 'flight assist on/off'],
  ['click L', 'fire cannon'], ['click R', 'fire missile (when locked)'],
  ['Tab', 'cycle hostile targets'], ['T', 'target under reticle'], ['G', 'mining drill on/off'],
  ['Space', 'dock / undock'], ['N', 'set destination to target / clear'],
  ['H', 'hail rescue tow (fuel emergency)'],
  ['M', 'system map'], ['B', 'cargo hold'], ['C', 'ship & modules'], ['J', 'contract journal'],
  ['K', 'market (docked)'], ['L', 'contacts'], ['V', 'cockpit / chase camera'],
  ['Enter', 'chat'], ['F1', 'this help'], ['Esc', 'close windows / pause menu'],
];

export class Menu {
  private root: HTMLElement;
  private helpRoot: HTMLElement;
  private statusLine: HTMLElement;
  visible = true;
  inGame = false;

  constructor(private cb: MenuCallbacks) {
    this.root = el('div', 'vf-menu');
    document.body.appendChild(this.root);
    this.helpRoot = el('div', 'vf-help');
    this.helpRoot.style.display = 'none';
    document.body.appendChild(this.helpRoot);
    this.buildHelp();
    this.statusLine = el('div', 'vf-menu-status', '');
    this.build();
  }

  private resumeBtn: HTMLButtonElement | null = null;

  private build(): void {
    const box = el('div', 'vf-menu-box');
    box.appendChild(el('div', 'vf-menu-title', 'VOID FREIGHTER'));
    box.appendChild(el('div', 'vf-menu-sub', 'the long haul · vesper system'));

    // resume button: only visible while a session is paused underneath
    this.resumeBtn = button('▶ RESUME FLIGHT  [Esc]', 'vf-btn big accept vf-resume', () => this.cb.resume());
    this.resumeBtn.style.display = 'none';
    box.appendChild(this.resumeBtn);

    const nameInput = document.createElement('input');
    nameInput.className = 'vf-input';
    nameInput.placeholder = 'pilot name';
    nameInput.maxLength = 16;
    nameInput.value = localStorage.getItem('vf_pilot') ?? '';

    const offlineBox = el('div', 'vf-menu-section');
    offlineBox.appendChild(el('div', 'vf-menu-h', 'SOLO (offline, saves in this browser)'));
    offlineBox.appendChild(nameInput);
    const row = el('div', 'vf-menu-row');
    if (OfflineWorld.hasSave()) {
      row.appendChild(button('CONTINUE', 'vf-btn big accept', () => {
        this.start(() => this.cb.startOffline(nameInput.value.trim() || 'Drifter', false), nameInput.value);
      }));
      row.appendChild(button('NEW GAME', 'vf-btn big danger', () => {
        if (!confirm('Wipe the existing save and start over?')) return;
        OfflineWorld.clearSave();
        this.start(() => this.cb.startOffline(nameInput.value.trim() || 'Drifter', true), nameInput.value);
      }));
    } else {
      row.appendChild(button('LAUNCH', 'vf-btn big accept', () => {
        this.start(() => this.cb.startOffline(nameInput.value.trim() || 'Drifter', true), nameInput.value);
      }));
    }
    offlineBox.appendChild(row);
    box.appendChild(offlineBox);

    const onlineBox = el('div', 'vf-menu-section');
    onlineBox.appendChild(el('div', 'vf-menu-h', 'ONLINE (shared world)'));
    const user = document.createElement('input');
    user.className = 'vf-input';
    user.placeholder = 'callsign (username)';
    user.maxLength = 24;
    user.value = localStorage.getItem('vf_user') ?? '';
    const pass = document.createElement('input');
    pass.className = 'vf-input';
    pass.type = 'password';
    pass.placeholder = 'password';
    onlineBox.appendChild(user);
    onlineBox.appendChild(pass);
    const orow = el('div', 'vf-menu-row');
    const doOnline = async (register: boolean) => {
      this.statusLine.textContent = 'connecting…';
      try {
        localStorage.setItem('vf_user', user.value);
        await this.cb.startOnline(user.value.trim(), pass.value, register);
        this.hide();
        this.inGame = true;
      } catch (err: any) {
        this.statusLine.textContent = `✕ ${err?.message ?? 'connection failed'}`;
      }
    };
    orow.appendChild(button('LOG IN', 'vf-btn big', () => void doOnline(false)));
    orow.appendChild(button('REGISTER', 'vf-btn big', () => void doOnline(true)));
    onlineBox.appendChild(orow);
    box.appendChild(onlineBox);
    box.appendChild(this.statusLine);

    box.appendChild(button('CONTROLS [F1]', 'vf-btn', () => this.toggleHelp()));
    box.appendChild(el('div', 'vf-menu-foot', 'all visuals & audio procedural · no assets were harmed'));
    this.root.appendChild(box);
  }

  private start(fn: () => void, pilotName: string): void {
    localStorage.setItem('vf_pilot', pilotName);
    fn();
    this.hide();
    this.inGame = true;
  }

  private buildHelp(): void {
    const box = el('div', 'vf-help-box');
    box.appendChild(el('div', 'vf-menu-h', 'FLIGHT MANUAL'));
    const grid = el('div', 'vf-help-grid');
    for (const [key, desc] of CONTROLS) {
      grid.appendChild(el('span', 'vf-key', key));
      grid.appendChild(el('span', 'vf-desc', desc));
    }
    box.appendChild(grid);
    box.appendChild(el('div', 'vf-help-tip',
      'Haul cargo, watch the fuel gauge, and do not trust an unresolved contact. ' +
      'If you run dry in the void, hail a rescue tow from the help menu… it will cost you.'));
    box.appendChild(button('CLOSE', 'vf-btn', () => this.toggleHelp()));
    this.helpRoot.appendChild(box);
  }

  toggleHelp(): void {
    this.helpRoot.style.display = this.helpRoot.style.display === 'none' ? 'flex' : 'none';
  }

  show(): void {
    this.visible = true;
    this.root.style.display = 'flex';
    if (this.resumeBtn) this.resumeBtn.style.display = this.inGame ? 'block' : 'none';
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = 'none';
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }
}
