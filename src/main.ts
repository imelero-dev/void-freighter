// Entry point: main menu -> offline (Sim in browser) or online (ClientWorld).
// The fixed world seed lives in src/sim/system.ts (WORLD_SEED).

import { GameApp } from './game/app';
import { OfflineWorld } from './offline_world';
import { Menu } from './ui/menu';
import type { IWorld } from './world_api';

const canvas = document.getElementById('game') as HTMLCanvasElement;

let app: GameApp | null = null;
let world: IWorld | null = null;

const menu = new Menu({
  startOffline(pilotName: string, fresh: boolean) {
    if (fresh) OfflineWorld.clearSave();
    const w = new OfflineWorld(pilotName);
    startGame(w);
  },
  async startOnline(username: string, password: string, register: boolean) {
    const { connectOnline } = await import('./net/client_world');
    const w = await connectOnline(username, password, register);
    startGame(w);
  },
});

function startGame(w: IWorld): void {
  world = w;
  app = new GameApp(w, canvas);
  app.menuHelp = () => menu.toggleHelp();
  app.onExit = () => {
    // Esc with no windows open: back to the menu (world keeps running offline)
    menu.show();
  };
}

// resume from the menu with Escape if a session exists
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Escape' && menu.visible && menu.inGame) {
    menu.hide();
  }
});

// save on tab close (offline)
window.addEventListener('beforeunload', () => {
  if (world instanceof OfflineWorld) world.save();
});
