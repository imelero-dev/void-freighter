// Window manager: dark amber panels over the 3D view. Opening any window
// releases pointer lock; Esc closes the top one.

import { el } from './dom';

export interface GameWindow {
  id: string;
  title: string;
  root: HTMLElement;      // outer panel (hidden/shown by the manager)
  body: HTMLElement;
  refresh(): void;        // re-render contents from world state
  onClose?(): void;
}

export class WindowManager {
  container: HTMLElement;
  private windows = new Map<string, GameWindow>();
  private open = new Set<string>();
  onChange: (() => void) | null = null;

  constructor() {
    this.container = el('div', 'vf-windows');
    document.body.appendChild(this.container);
  }

  register(id: string, title: string, wide = false): GameWindow {
    const root = el('div', `vf-window${wide ? ' wide' : ''}`);
    root.style.display = 'none';
    const bar = el('div', 'vf-titlebar');
    bar.appendChild(el('span', 'vf-title', title));
    const close = el('button', 'vf-close', '✕');
    close.addEventListener('click', () => this.close(id));
    bar.appendChild(close);
    const body = el('div', 'vf-body');
    root.appendChild(bar);
    root.appendChild(body);
    this.container.appendChild(root);
    const win: GameWindow = { id, title, root, body, refresh: () => {} };
    this.windows.set(id, win);
    return win;
  }

  setTitle(id: string, title: string): void {
    const win = this.windows.get(id);
    if (win) win.root.querySelector('.vf-title')!.textContent = title;
  }

  toggle(id: string): void {
    if (this.open.has(id)) this.close(id);
    else this.show(id);
  }

  show(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    win.root.style.display = 'flex';
    this.open.add(id);
    win.refresh();
    this.onChange?.();
  }

  close(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    win.root.style.display = 'none';
    this.open.delete(id);
    win.onClose?.();
    this.onChange?.();
  }

  closeTop(): boolean {
    const last = [...this.open].pop();
    if (last === undefined) return false;
    this.close(last);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.open]) this.close(id);
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  anyOpen(): boolean {
    return this.open.size > 0;
  }

  refreshOpen(): void {
    for (const id of this.open) this.windows.get(id)?.refresh();
  }
}
