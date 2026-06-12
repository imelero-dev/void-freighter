// Tiny DOM helpers for the UI layer.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

export function fmtCredits(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} cr`;
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 1_000_000) return `${(m / 1000).toFixed(1)} km`;
  return `${(m / 1_000_000).toFixed(2)} Mm`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
