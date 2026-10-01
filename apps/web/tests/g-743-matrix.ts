import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { axeViolations, formatViolations } from './a11y-axe.ts';

// The launch-journey accessibility matrix (G-743). A journey test drives its screens as the other journey tests
// do and calls `checkScreen` on each one; the matrix is what every screen must hold in every engine project of
// `playwright.config.ts`:
//   - axe, WCAG 2.2 A and AA, in light and dark, at a phone and a desktop width;
//   - reflow at 200% and 400% zoom (a 1280 px window at 200% lays out at 640 CSS px, at 400% at 320);
//   - keyboard-only use with a visible, unobscured focus indicator (`keyboardReach`, `focusStops`);
//   - reduced motion (`motionRunning`);
//   - a CJK and a Latin locale (`locales`), CJK IME input into text fields (`composeCjk`).
// `scripts/qa/cases/launch-journeys.ts` lists the journeys; `g-743-journeys.test.ts` fails when one is missing a part.

export const themes = ['light', 'dark'] as const;
export type Theme = (typeof themes)[number];
export const sizes = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;
export const reflowWidths = [640, 320] as const;
/** One Latin and one CJK interface locale; the CJK one is the language of the IME input checks. */
export const locales = { latin: 'en', cjk: 'ja' } as const;

/** What a screen check found wrong, one line per problem, so one failing screen does not hide the next. */
export type Findings = string[];

/** Show the theme under test and settle motion, as the display menu does (a signed-in reader's saved mode wins over the cookie). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(chosen => {
    // No colour transitions, so axe and the screenshot see the settled theme rather than a blend of both.
    if (!document.getElementById('g743-settle')) {
      const style = document.createElement('style');
      style.id = 'g743-settle';
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.append(style);
    }
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(chosen);
  }, theme);
}

const wide = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

/**
 * The screen as it stands, in both themes at both widths, then at the two zoom reflow widths. Returns the findings
 * (and attaches them to the test as annotations) rather than throwing, so the journey carries on to its next screen;
 * `expectClean` makes them the test's result.
 */
export async function checkScreen(page: Page, name: string, found: Findings, info?: TestInfo,
  options: { exclude?: string[]; themes?: readonly Theme[] } = {}): Promise<void> {
  const original = page.viewportSize() ?? sizes.desktop;
  try {
    for (const theme of options.themes ?? themes) {
      for (const [label, size] of Object.entries(sizes)) {
        await page.setViewportSize(size);
        await setTheme(page, theme);
        const label2 = `${name} ${theme} ${label}`;
        const violations = await axeViolations(page, options.exclude ? { exclude: options.exclude } : {});
        if (violations.length) found.push(`${label2}\n${formatViolations(violations)}`);
        const over = await wide(page);
        if (over > 1) found.push(`${label2} scrolls sideways by ${over}px`);
      }
    }
    for (const width of reflowWidths) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(50);
      const over = await wide(page);
      if (over > 1) found.push(`${name} at ${width} CSS px (zoom ${1280 / width * 100}%) scrolls sideways by ${over}px`);
    }
  } finally {
    await page.setViewportSize(original);
    // The settling style hides motion; take it off so the reduced-motion check sees what the page really does.
    await page.evaluate(() => document.getElementById('g743-settle')?.remove());
  }
  if (info) await page.screenshot({ path: info.outputPath(`${name.replaceAll(/[^\w-]+/g, '-')}.png`) });
}

/** Make the findings the test's result; the message lists every one. */
export function expectClean(found: Findings): void {
  expect(found, found.join('\n\n')).toEqual([]);
}

/** Whether the focused element draws a focus indicator (an outline or a ring) and is not covered by something else. */
export interface FocusStop { name: string; ring: boolean; covered: boolean; offscreen: boolean }

export const focusStop = (page: Page): Promise<FocusStop> => page.evaluate(() => {
  const element = document.activeElement as HTMLElement | null;
  if (!element || element === document.body) return { name: 'body', ring: false, covered: false, offscreen: false };
  const style = getComputedStyle(element);
  const ring = (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
    // A control drawn by its parent (a styled radio or checkbox) shows its ring on that parent.
    || [element.parentElement, element.closest('label')].some(parent => {
      if (!parent) return false;
      const parentStyle = getComputedStyle(parent);
      return (parentStyle.outlineStyle !== 'none' && Number.parseFloat(parentStyle.outlineWidth) > 0) || parentStyle.boxShadow !== 'none';
    });
  const box = element.getBoundingClientRect();
  const offscreen = box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > innerHeight
    || box.right < 0 || box.left > innerWidth;
  // WCAG 2.4.11: a sticky bar must not hide the focused element. Look at the point that is most visible.
  const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  const covered = !offscreen && !!top && top !== element && !element.contains(top) && !top.contains(element)
    && !element.closest('label')?.contains(top);
  return { name: `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''}`.trim(),
    ring, covered, offscreen };
});

/**
 * Move to `target` with Tab (then Shift+Tab, in case it lies behind) and nothing else, noting every stop that
 * shows no focus indicator or is hidden behind something. Throws when the target cannot be reached.
 */
export async function keyboardReach(page: Page, target: Locator, found: Findings, label: string, max = 120): Promise<void> {
  const reached = () => target.evaluate(element => element === document.activeElement || element.contains(document.activeElement))
    .catch(() => false);
  const seen = new Set<string>();
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    for (let stop = 0; stop < max; stop += 1) {
      if (await reached()) return;
      await page.keyboard.press(key);
      const focus = await focusStop(page);
      const id = `${focus.name}`;
      if (!focus.ring && focus.name !== 'body' && !seen.has(`ring ${id}`)) { seen.add(`ring ${id}`); found.push(`${label}: no focus indicator on ${id}`); }
      if (focus.covered && !seen.has(`cover ${id}`)) { seen.add(`cover ${id}`); found.push(`${label}: focus is hidden behind another element on ${id}`); }
      if (await reached()) return;
    }
  }
  throw new Error(`${label}: the keyboard could not reach the control (Tab and Shift+Tab, ${max} stops each)`);
}

/** Activate the focused control with the keyboard: Enter, or Space for what Space activates. */
export async function activate(page: Page, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await page.keyboard.press(key === 'Space' ? ' ' : 'Enter');
}

/** Focus `target` by Tab alone and activate it, the way a keyboard-only reader operates a control. */
export async function pressByKeyboard(page: Page, target: Locator, found: Findings, label: string, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await keyboardReach(page, target, found, label);
  await activate(page, key);
}

/** Animations and transitions still running that last longer than a blink: under reduced motion there should be none. */
export const motionRunning = (page: Page): Promise<string[]> => page.evaluate(() => document.getAnimations()
  .filter(animation => animation.playState === 'running')
  .map(animation => {
    const timing = animation.effect?.getComputedTiming();
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return { name: (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? 'animation',
      duration: Number(timing?.duration ?? 0), target: target ? `${target.tagName.toLowerCase()}${target.className ? `.${String(target.className).split(' ')[0]}` : ''}` : '' };
  })
  .filter(item => item.duration > 10)
  .map(item => `${item.name} on ${item.target} (${item.duration}ms)`));

/**
 * Compose `text` in a field the way a CJK input method does: composition events with an uncommitted preedit, an Enter
 * that belongs to the composition (`isComposing`, keyCode 229, as an IME's candidate confirmation arrives), then the
 * commit. Chromium only (a CDP call); WebKit and the physical phones are checked by hand (see the journeys' notes).
 * Returns what the field held mid-composition and after the commit, and whether the composition's Enter submitted
 * the form or was swallowed by a key handler.
 */
export async function composeCjk(page: Page, field: Locator, text: string): Promise<{ value: string; duringComposition: string; submitted: boolean }> {
  const session = await page.context().newCDPSession(page);
  try {
    await field.focus();
    await field.evaluate(element => {
      const target = globalThis as unknown as { __g743Submits?: number };
      target.__g743Submits = 0;
      element.closest('form')?.addEventListener('submit', () => { target.__g743Submits = (target.__g743Submits ?? 0) + 1; });
    });
    // Each prefix is an uncommitted composition, as kana or pinyin is before a candidate is chosen.
    let duringComposition = '';
    for (let end = 1; end <= text.length; end += 1) {
      await session.send('Input.imeSetComposition', { text: text.slice(0, end), selectionStart: end, selectionEnd: end });
      duringComposition = await field.inputValue();
    }
    await field.evaluate(element => {
      for (const type of ['keydown', 'keyup'] as const) {
        element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      }
    });
    await session.send('Input.insertText', { text });
    const submitted = (await page.evaluate(() => (globalThis as unknown as { __g743Submits?: number }).__g743Submits ?? 0)) > 0;
    return { value: await field.inputValue(), duringComposition, submitted };
  } finally { await session.detach(); }
}
