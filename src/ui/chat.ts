// Chat overlay: message history + input line (Enter to open, Esc to close).

import { el } from './dom';
import type { IWorld } from '../world_api';

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
    this.inputWrap.style.display = 'block';
    this.input.focus();
    this.onOpenChange?.(true);
  }

  closeInput(): void {
    this.open = false;
    this.inputWrap.style.display = 'none';
    this.input.blur();
    this.onOpenChange?.(false);
  }

  addMessage(from: string, text: string, channel: string): void {
    const line = el('div', `vf-chat-line ${channel}`);
    line.textContent = channel === 'system' ? text : `[${channel}] ${from}: ${text}`;
    this.list.appendChild(line);
    while (this.list.children.length > 8) this.list.removeChild(this.list.firstChild!);
    setTimeout(() => {
      line.classList.add('fade');
      setTimeout(() => line.remove(), 4000);
    }, 14_000);
  }
}
