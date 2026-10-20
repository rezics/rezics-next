import { expect, waitFor, within } from 'storybook/test';

/** A short-window regression for focus scrolling; native tab zoom is verified separately. */
export async function expectReadingFocusClearsShell(canvasElement: HTMLElement) {
  const { page, userEvent: keyboard } = await import('vitest/browser');
  await page.viewport(360, 228);
  await document.fonts.ready;
  const reading = await within(canvasElement).findByRole('region', { name: 'Currently reading' });
  const actions = within(reading).getAllByRole('link', { name: /^(Continue|Open)/ });
  expect(actions.length).toBeGreaterThanOrEqual(2);
  // Start before the first action, then use trusted Tab presses to establish keyboard focus.
  actions[0]!.focus();
  await keyboard.tab({ shift: true });
  for (const action of actions) {
    for (let step = 0; step < 60 && document.activeElement !== action; step++) await keyboard.tab();
    await waitFor(() => {
      const bounds = action.getBoundingClientRect();
      const headerBottom = canvasElement.querySelector('header')!.getBoundingClientRect().bottom;
      const bottom = Math.min(innerHeight, ...[...canvasElement.querySelectorAll('nav')]
        .filter(nav => getComputedStyle(nav).position === 'fixed' && nav.checkVisibility()
          && nav.getBoundingClientRect().height > 0)
        .map(nav => nav.getBoundingClientRect().top));
      expect(action).toHaveFocus();
      expect(action.matches(':focus-visible')).toBe(true);
      expect(bounds.top).toBeGreaterThanOrEqual(headerBottom);
      expect(bounds.bottom).toBeLessThanOrEqual(bottom);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
}
