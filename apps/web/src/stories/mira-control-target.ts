import { expect } from 'storybook/test';

export function expectCompactMiraTarget(control: HTMLElement, height: 24 | 28, square = false): DOMRect {
  control.scrollIntoView({ block: 'center', inline: 'nearest' });
  const box = control.getBoundingClientRect();
  expect(box.height).toBeCloseTo(height);
  if (square) expect(box.width).toBeCloseTo(height);

  const doc = control.ownerDocument;
  const view = doc.defaultView!;
  if (view.matchMedia('(width < 48rem), (pointer: coarse)').matches) {
    const hitbox = view.getComputedStyle(control, '::before');
    const width = Number.parseFloat(hitbox.width);
    const hitHeight = Number.parseFloat(hitbox.height);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(hitHeight).toBeGreaterThanOrEqual(44);
    const left = box.left + control.clientLeft + Number.parseFloat(hitbox.left);
    const top = box.top + control.clientTop + Number.parseFloat(hitbox.top);
    // Sample the expanded target's corners and edges to catch clipping and competing controls.
    for (const clientX of [left + 1, left + width / 2, left + width - 1]) {
      for (const clientY of [top + 1, top + hitHeight / 2, top + hitHeight - 1]) {
        expect(control.contains(doc.elementFromPoint(clientX, clientY))).toBe(true);
      }
    }
  }
  return box;
}
