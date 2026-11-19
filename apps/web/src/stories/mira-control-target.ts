import { expect } from 'storybook/test';

export function expectCompactMiraTarget(control: HTMLElement, height: 24 | 28, square = false): DOMRect {
  control.scrollIntoView({ block: 'center', inline: 'nearest' });
  const box = control.getBoundingClientRect();
  expect(box.height).toBeCloseTo(height);
  if (square) expect(box.width).toBeCloseTo(height);

  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hits = (clientX: number, clientY: number) =>
    control.contains(control.ownerDocument.elementFromPoint(clientX, clientY));

  expect([hits(x, box.top + 1), hits(x, box.bottom - 1), hits(box.left + 1, y), hits(box.right - 1, y)]).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect([hits(x, box.top - 1), hits(x, box.bottom + 1), hits(box.left - 1, y), hits(box.right + 1, y)]).toEqual([
    false,
    false,
    false,
    false,
  ]);
  return box;
}
