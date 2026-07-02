// Compact ATC approach overlay (#20): appears when clearance is granted,
// lets the pilot pick a pad / dock type, then collapses to a one-line chip
// so it never obstructs the approach itself.

import { el } from './dom';

export interface SlotOption {
  id: string;
  label: string;
}

export class ApproachOverlay {
  private root: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private chip: HTMLElement;
  private options: SlotOption[] = [];
  private assigned = '';
  private collapsed = false;
  visible = false;

  constructor(private onSelect: (id: string) => void) {
    this.root = el('div', 'vf-approach');
    this.title = el('div', 'vf-approach-title');
    this.body = el('div', 'vf-approach-body');
    this.chip = el('div', 'vf-approach-chip');
    this.chip.addEventListener('click', () => {
      this.collapsed = false;
      this.render();
    });
    this.root.appendChild(this.title);
    this.root.appendChild(this.body);
    this.root.appendChild(this.chip);
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
  }

  show(targetName: string, options: SlotOption[], assigned: string): void {
    this.options = options;
    this.assigned = assigned;
    this.collapsed = false;
    this.visible = true;
    this.title.textContent = `ATC — ${targetName.toUpperCase()}`;
    this.root.style.display = 'block';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.root.style.display = 'none';
  }

  private render(): void {
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    if (this.collapsed) {
      this.body.style.display = 'none';
      this.title.style.display = 'none';
      const label = this.options.find((o) => o.id === this.assigned)?.label ?? this.assigned;
      this.chip.textContent = `◤ ${label.split('—')[0].trim()} — cleared`;
      this.chip.style.display = 'block';
      return;
    }
    this.body.style.display = 'block';
    this.title.style.display = 'block';
    this.chip.style.display = 'none';
    for (const opt of this.options) {
      const row = el('button', `vf-approach-slot${opt.id === this.assigned ? ' assigned' : ''}`);
      row.textContent = `${opt.id === this.assigned ? '▸ ' : ''}${opt.label}`;
      row.addEventListener('click', () => {
        this.assigned = opt.id;
        this.onSelect(opt.id);
        this.collapsed = true;
        this.render();
      });
      this.body.appendChild(row);
    }
    const ok = el('button', 'vf-approach-slot confirm');
    ok.textContent = '✓ CONFIRM — collapse';
    ok.addEventListener('click', () => {
      this.collapsed = true;
      this.render();
    });
    this.body.appendChild(ok);
  }
}
