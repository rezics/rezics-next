import { expect } from 'storybook/test';

/** Visual box stays the official Mira size. Pointer reach is the painted hit extension. */
export async function expectSubjectPointerTarget(control: HTMLElement) {
  control.scrollIntoView({ block: 'center', inline: 'nearest' });
  const view = control.ownerDocument.defaultView!;
  const rect = control.getBoundingClientRect();
  const hit = view.getComputedStyle(control, '::before');
  const after = view.getComputedStyle(control, '::after');
  const beforeWidth = Number.parseFloat(hit.width);
  const beforeHeight = Number.parseFloat(hit.height);
  const afterWidth = Number.parseFloat(after.width);
  const afterHeight = Number.parseFloat(after.height);
  const beforeReaches = beforeWidth >= 44 && beforeHeight >= 44;
  const afterReaches = afterWidth >= 44 && afterHeight >= 44;
  const useAfter = !beforeReaches && afterReaches;
  const width = useAfter ? afterWidth : beforeWidth;
  const height = useAfter ? afterHeight : beforeHeight;
  const box = useAfter ? after : hit;
  await expect(width, control.textContent ?? '').toBeGreaterThanOrEqual(44);
  await expect(height, control.textContent ?? '').toBeGreaterThanOrEqual(44);
  const x = rect.left + control.clientLeft + Number.parseFloat(box.left);
  const y = rect.top + control.clientTop + Number.parseFloat(box.top);
  const doc = control.ownerDocument;
  const misses = [];
  for (const hitX of [x + 1, x + width / 2, x + width - 1]) {
    for (const hitY of [y + 1, y + height / 2, y + height - 1]) {
      const found = doc.elementFromPoint(hitX, hitY);
      if (!found || !control.contains(found)) misses.push([Math.round(hitX), Math.round(hitY)]);
    }
  }
  await expect(misses, `pointer reach for ${control.textContent}`).toEqual([]);
}
