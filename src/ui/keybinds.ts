// Rebindable keyboard controls + HOTAS/gamepad bindings, persisted to
// localStorage. The InputManager and GamepadManager read from here.

export interface BindDef {
  id: string;
  label: string;
  def: string; // default KeyboardEvent.code
}

export const BINDABLE: BindDef[] = [
  { id: 'throttleUp', label: 'Throttle up', def: 'KeyW' },
  { id: 'throttleDown', label: 'Throttle down / brake', def: 'KeyS' },
  { id: 'cutThrottle', label: 'Cut throttle', def: 'KeyX' },
  { id: 'strafeLeft', label: 'Strafe left', def: 'KeyA' },
  { id: 'strafeRight', label: 'Strafe right', def: 'KeyD' },
  { id: 'strafeUp', label: 'Strafe up', def: 'KeyR' },
  { id: 'strafeDown', label: 'Strafe down', def: 'KeyF' },
  { id: 'rollLeft', label: 'Roll left', def: 'KeyQ' },
  { id: 'rollRight', label: 'Roll right', def: 'KeyE' },
  { id: 'cruise', label: 'Cruise drive', def: 'CapsLock' },
  { id: 'assist', label: 'Flight assist', def: 'KeyZ' },
  { id: 'drill', label: 'Mining drill', def: 'KeyG' },
  { id: 'dock', label: 'Dock / undock', def: 'Space' },
  { id: 'tab', label: 'Cycle hostiles', def: 'Tab' },
  { id: 'reticle', label: 'Target reticle', def: 'KeyT' },
  { id: 'dest', label: 'Set destination', def: 'KeyN' },
  { id: 'camera', label: 'Camera view', def: 'KeyV' },
  { id: 'rescue', label: 'Hail rescue tow', def: 'KeyH' },
  { id: 'hail', label: 'Hail trader', def: 'KeyU' },
  { id: 'lights', label: 'Headlights', def: 'KeyI' },
  { id: 'map', label: 'System chart', def: 'KeyM' },
  { id: 'cargo', label: 'Cargo hold', def: 'KeyB' },
  { id: 'ship', label: 'Ship & modules', def: 'KeyC' },
  { id: 'journal', label: 'Contract journal', def: 'KeyJ' },
  { id: 'market', label: 'Market', def: 'KeyK' },
  { id: 'contacts', label: 'Contacts', def: 'KeyL' },
  { id: 'chat', label: 'Chat', def: 'Enter' },
  { id: 'help', label: 'Flight manual', def: 'F1' },
];

const KEY_STORE = 'vf_keybinds_v1';

function loadBinds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of BINDABLE) out[b.id] = b.def;
  try {
    const raw = localStorage.getItem(KEY_STORE);
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const b of BINDABLE) {
        if (typeof parsed[b.id] === 'string') out[b.id] = parsed[b.id];
      }
    }
  } catch { /* defaults */ }
  return out;
}

export const binds: Record<string, string> = loadBinds();

export function setBind(id: string, code: string): void {
  // a key can serve only one action: clear duplicates
  for (const key of Object.keys(binds)) {
    if (binds[key] === code && key !== id) binds[key] = '';
  }
  binds[id] = code;
  save();
}

export function resetBinds(): void {
  for (const b of BINDABLE) binds[b.id] = b.def;
  save();
}

function save(): void {
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify(binds));
  } catch { /* private mode */ }
}

export function keyLabel(code: string): string {
  if (!code) return '—';
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace('ShiftLeft', 'L-SHIFT').replace('ShiftRight', 'R-SHIFT')
    .replace('ControlLeft', 'L-CTRL').replace('ControlRight', 'R-CTRL')
    .replace('CapsLock', 'CAPS').replace('Space', 'SPACE')
    .replace('Enter', 'ENTER').replace('Tab', 'TAB')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// HOTAS / gamepad config
// ---------------------------------------------------------------------------

export interface AxisBind {
  index: number;
  invert: boolean;
}

export type HotasAxis = 'pitch' | 'yaw' | 'roll' | 'throttle';
export type HotasButton = 'fire' | 'missile' | 'cruise' | 'turbo' | 'dock' | 'tab' | 'drill';

export interface HotasConfig {
  axes: Partial<Record<HotasAxis, AxisBind>>;
  buttons: Partial<Record<HotasButton, number>>;
}

const HOTAS_STORE = 'vf_hotas_v1';

function loadHotas(): HotasConfig {
  try {
    const raw = localStorage.getItem(HOTAS_STORE);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { axes: parsed.axes ?? {}, buttons: parsed.buttons ?? {} };
    }
  } catch { /* fresh */ }
  return { axes: {}, buttons: {} };
}

export const hotas: HotasConfig = loadHotas();

export function saveHotas(): void {
  try {
    localStorage.setItem(HOTAS_STORE, JSON.stringify(hotas));
  } catch { /* private mode */ }
}

export const HOTAS_AXES: Array<{ id: HotasAxis; label: string }> = [
  { id: 'pitch', label: 'Pitch axis' },
  { id: 'yaw', label: 'Yaw axis' },
  { id: 'roll', label: 'Roll axis' },
  { id: 'throttle', label: 'Throttle axis' },
];

export const HOTAS_BUTTONS: Array<{ id: HotasButton; label: string }> = [
  { id: 'fire', label: 'Fire cannon (hold)' },
  { id: 'missile', label: 'Fire missile' },
  { id: 'turbo', label: 'Turbo (hold)' },
  { id: 'cruise', label: 'Cruise drive' },
  { id: 'dock', label: 'Dock / undock' },
  { id: 'tab', label: 'Cycle hostiles' },
  { id: 'drill', label: 'Mining drill' },
];
