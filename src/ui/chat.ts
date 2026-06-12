// Chat overlay: message history + input line (Enter to open, Esc to close).
// Recent messages fade from the overlay after a few seconds, but the full
// history (incl. NPC radio traffic) is shown while the chat is open.

import { el } from './dom';
import type { IWorld } from '../world_api';

const HISTORY_CAP = 60;
const FADE_MS = 14_000;

export class ChatUi {
  private root: HTMLElement;
  private list: HTMLElement;
  private inputWrap: HTMLElement;
  private input: HTMLInputElement;
  open = false;
  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(private world: () => IWorld | null) {
    this.root = el('div', 'vf-chat');
    this.list = el('div', 'vf-chat-list');
    this.inputWrap = el('div', 'vf-chat-inputwrap');
    this.input = document.createElement('input');
    this.input.className = 'vf-chat-input';
    this.input.maxLength = 240;
    this.input.placeholder = 'say something into the void…';
    this.inputWrap.appendChild(this.input);
    this.inputWrap.style.display = 'none';
    this.root.appendChild(this.list);
    this.root.appendChild(this.inputWrap);
    document.body.appendChild(this.root);

    this.input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.code === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.world()?.chat(text);
        this.input.value = '';
        this.closeInput();
      } else if (ev.code === 'Escape') {
        this.input.value = '';
        this.closeInput();
      }
    });
  }

  openInput(): void {
    if (this.open) return;
    this.open = true;
    this.root.classList.add('open');
    this.inputWrap.style.display = 'block';
    this.input.focus();
    this.list.scrollTop = this.list.scrollHeight;
    this.onOpenChange?.(true);
  }

  closeInput(): void {
    this.open = false;
    this.root.classList.remove('open');
    this.inputWrap.style.display = 'none';
    this.input.blur();
    this.onOpenChange?.(false);
  }

  // channel 'radio' = NPC traffic/comms; kept in history like everything else
  addMessage(from: string, text: string, channel: string): void {
    const line = el('div', `vf-chat-line ${channel}`);
    const prefix = channel === 'radio' ? '⌁ ' : '';
    line.textContent = channel === 'system' ? text
      : channel === 'radio' ? `${prefix}${from ? `${from}: ` : ''}${text}`
        : `[${channel}] ${from}: ${text}`;
    this.list.appendChild(line);
    while (this.list.children.length > HISTORY_CAP) this.list.removeChild(this.list.firstChild!);
    // fade from the overlay, but stay in history (visible while chat is open)
    setTimeout(() => line.classList.add('faded'), FADE_MS);
    if (this.open) this.list.scrollTop = this.list.scrollHeight;
  }
}
