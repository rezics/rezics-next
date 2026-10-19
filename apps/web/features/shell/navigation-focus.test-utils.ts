import { expect, userEvent, waitFor } from 'storybook/test';

/** Measure the painted indicator independently of the production reveal gutter. */
function focusOutset(element: HTMLElement) {
  const style = getComputedStyle(element);
  const outline = style.outlineStyle === 'none' ? 0
    : Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset));
  const outset = { left: outline, right: outline, top: outline, bottom: outline };
  for (const shadow of style.boxShadow.split(/,(?![^()]*\))/)) {
    if (shadow.includes('inset')) continue;
    const lengths = [...shadow.matchAll(/(-?(?:\d*\.)?\d+)px/g)].map(match => Number(match[1]));
    if (lengths.length < 3) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    const radius = blur + spread;
    outset.left = Math.max(outset.left, radius - x);
    outset.right = Math.max(outset.right, radius + x);
    outset.top = Math.max(outset.top, radius - y);
    outset.bottom = Math.max(outset.bottom, radius + y);
  }
  return outset;
}

/** Selection and its in-box marker must be revealed before keyboard movement begins. */
export async function expectRevealedSelection(element: HTMLElement) {
  await waitFor(async () => {
    const selected = element.getBoundingClientRect();
    await expect(selected.left).toBeGreaterThanOrEqual(-0.5);
    await expect(selected.right).toBeLessThanOrEqual(innerWidth + 0.5);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(parent).overflowX)) continue;
      const bounds = parent.getBoundingClientRect();
      await expect(selected.left).toBeGreaterThanOrEqual(bounds.left + parent.clientLeft - 0.5);
      await expect(selected.right).toBeLessThanOrEqual(bounds.left + parent.clientLeft + parent.clientWidth + 0.5);
    }
  });
}

export async function expectUnclippedFocus(element: HTMLElement) {
  await waitFor(async () => {
    await expect(element).toHaveFocus();
    await expect(element.matches(':focus-visible')).toBe(true);
    const ring = focusOutset(element);
    await expect(Math.max(...Object.values(ring))).toBeGreaterThan(0);
    const box = element.getBoundingClientRect();
    const painted = { left: box.left - ring.left, right: box.right + ring.right,
      top: box.top - ring.top, bottom: box.bottom + ring.bottom };
    // The viewport and each actual clipping ancestor constrain the painted ring, not just the link box.
    await expect(painted.left).toBeGreaterThanOrEqual(-0.5);
    await expect(painted.right).toBeLessThanOrEqual(innerWidth + 0.5);
    await expect(painted.top).toBeGreaterThanOrEqual(-0.5);
    await expect(painted.bottom).toBeLessThanOrEqual(innerHeight + 0.5);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        await expect(painted.left, `left focus ring clipped by ${parent.tagName}`).toBeGreaterThanOrEqual(
          bounds.left + parent.clientLeft - 0.5);
        await expect(painted.right, `right focus ring clipped by ${parent.tagName}`).toBeLessThanOrEqual(
          bounds.left + parent.clientLeft + parent.clientWidth + 0.5);
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        await expect(painted.top, `top focus ring clipped by ${parent.tagName}`).toBeGreaterThanOrEqual(
          bounds.top + parent.clientTop - 0.5);
        await expect(painted.bottom, `bottom focus ring clipped by ${parent.tagName}`).toBeLessThanOrEqual(
          bounds.top + parent.clientTop + parent.clientHeight + 0.5);
      }
    }
  });
}

/** Exercise both physical row edges with real Tab/Shift+Tab, without activating a destination. */
export async function expectNavigationFocus(navigation: HTMLElement) {
  const controls = [...navigation.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')];
  // Enter the first link by keyboard even when the row initially reveals its last selected destination.
  controls[1]!.focus();
  await userEvent.tab({ shift: true });
  await expectUnclippedFocus(controls[0]!);
  for (const link of controls.slice(1)) {
    await userEvent.tab();
    await expectUnclippedFocus(link);
  }
  for (const link of controls.slice(0, -1).reverse()) {
    await userEvent.tab({ shift: true });
    await expectUnclippedFocus(link);
  }
  // Leave the end destination focused for the retained rendered review.
  controls.at(-2)!.focus();
  await userEvent.tab();
  await expectUnclippedFocus(controls.at(-1)!);
}
