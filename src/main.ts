// Entry point: main menu -> offline (Sim in browser) or online (ClientWorld).
// The fixed world seed lives in src/sim/system.ts (WORLD_SEED).

import { GameApp } from './game/app';
import { OfflineWorld } from './offline_world';
import * as vec from './sim/vec';
import { Menu } from './ui/menu';
import type { IWorld } from './world_api';

const canvas = document.getElementById('game') as HTMLCanvasElement;

let app: GameApp | null = null;
let world: IWorld | null = null;

const menu = new Menu({
  startOffline(pilotName: string, fresh: boolean) {
    if (app && world instanceof OfflineWorld && !fresh) {
      // session already running: CONTINUE means resume, not recreate
      menu.hide();
      return;
    }
    if (app) {
      // switching sessions mid-game: a clean reload avoids duplicated apps
      if (fresh) OfflineWorld.clearSave();
      location.reload();
      return;
    }
    if (fresh) OfflineWorld.clearSave();
    const w = new OfflineWorld(pilotName);
    startGame(w);
  },
  async startOnline(username: string, password: string, register: boolean) {
    if (app) {
      menu.setStatus('Ya hay una partida en curso — recarga la página (F5) para cambiar de modo.');
      throw new Error('refresh the page (F5) to switch modes');
    }
    const { connectOnline } = await import('./net/client_world');
    const w = await connectOnline(username, password, register);
    startGame(w);
  },
  resume() {
    menu.hide();
    if (app) app.paused = false;
  },
  settingsChanged() {
    app?.applySettings();
  },
});

function startGame(w: IWorld): void {
  world = w;
  (window as any).VF = { world: w, vec }; // exposed for E2E scripts/bots
  app = new GameApp(w, canvas);
  app.menuHelp = () => menu.toggleHelp();
  // Esc with no windows open toggles the pause menu; the world keeps running
  // underneath and the save is flushed on every pause
  app.onExit = () => {
    if (menu.visible) {
      menu.hide();
      app!.paused = false;
    } else {
      if (world instanceof OfflineWorld) world.save();
      app!.paused = true; // offline: the universe truly stops
      menu.show();
    }
  };
}

// save on tab close (offline)
window.addEventListener('beforeunload', () => {
  if (world instanceof OfflineWorld) world.save();
});
