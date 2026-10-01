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

/**
 * How far the page is wider than the viewport that was asked for. Not `innerWidth`: a phone engine widens its layout
 * viewport to fit overflowing content, which would hide the overflow from a measure against it.
 */
const wide = (page: Page) => page.evaluate(requested => document.documentElement.scrollWidth - requested, page.viewportSize()!.width);

/** The elements that reach furthest past the right edge, for the finding that reports the overflow. */
const widest = (page: Page) => page.evaluate(requested => [...document.querySelectorAll('body *')]
  .map(element => ({ element, right: element.getBoundingClientRect().right }))
  .filter(item => item.right > requested + 1)
  // What a scroller or a clipped box holds past its edge is not what widens the page.
  .filter(({ element }) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) return false;
    }
    return true;
  })
  // Only the innermost box at each edge: its ancestors reach as far because it does.
  .filter(({ element, right }) => ![...element.children].some(child => child.getBoundingClientRect().right >= right - 0.5))
  .sort((a, b) => b.right - a.right).slice(0, 5)
  .map(({ element, right }) => `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().split(/\s+/).slice(0, 4).join('.')}` : ''} ends at ${Math.round(right)}px: ${element.textContent?.trim().slice(0, 50)}`)
  .join('; '), page.viewportSize()!.width);

/**
 * The screen as it stands, in both themes at both widths, then at the two zoom reflow widths. Returns the findings
 * (and attaches them to the test as annotations) rather than throwing, so the journey carries on to its next screen;
 * `expectClean` makes them the test's result.
 */
export async function checkScreen(page: Page, name: string, found: Findings, info?: TestInfo,
  options: { exclude?: string[]; themes?: readonly Theme[]; knownOverflow?: string } = {}): Promise<void> {
  const original = page.viewportSize() ?? sizes.desktop;
  // An overflow another task already owns is an annotation on this test; its own test (named for the owner) fails until it is fixed.
  const sideways = async (message: string) => {
    if (options.knownOverflow && info) info.annotations.push({ type: 'finding', description: `${options.knownOverflow}: ${message}` });
    else found.push(message);
  };
  try {
    for (const theme of options.themes ?? themes) {
      for (const [label, size] of Object.entries(sizes)) {
        await page.setViewportSize(size);
        await setTheme(page, theme);
        const label2 = `${name} ${theme} ${label}`;
        const violations = await axeViolations(page, options.exclude ? { exclude: options.exclude } : {});
        if (violations.length) found.push(`${label2}\n${formatViolations(violations)}`);
        const over = await wide(page);
        if (over > 1) await sideways(`${label2} scrolls sideways by ${over}px (${await widest(page)})`);
      }
    }
    for (const width of reflowWidths) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(50);
      const over = await wide(page);
      if (over > 1) await sideways(`${name} at ${width} CSS px (zoom ${1280 / width * 100}%) scrolls sideways by ${over}px (${await widest(page)})`);
    }
  } finally {
    await page.setViewportSize(original);
    // The settling style hides motion; take it off so the reduced-motion check sees what the page really does.
    await page.evaluate(() => document.getElementById('g743-settle')?.remove());
  }
  if (info) await page.screenshot({ path: info.outputPath(`${name.replaceAll(/[^\w-]+/g, '-')}.png`) });
}

/** Only the horizontal-overflow part of the matrix, at a phone width and at the two zoom reflow widths. */
export async function checkReflow(page: Page, name: string, found: Findings): Promise<void> {
  const original = page.viewportSize() ?? sizes.desktop;
  try {
    for (const width of [sizes.phone.width, ...reflowWidths]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(50);
      const over = await wide(page);
      if (over > 1) found.push(`${name} at ${width} CSS px scrolls sideways by ${over}px (${await widest(page)})`);
    }
  } finally { await page.setViewportSize(original); }
}

/** Make the findings the test's result; the message lists every one. */
export function expectClean(found: Findings): void {
  expect(found, found.join('\n\n')).toEqual([]);
}

/** Whether the focused element draws a focus indicator (an outline or a ring) and is not covered by something else. */
export interface FocusStop { name: string; ring: boolean; covered: boolean; offscreen: boolean; coveredBy?: string }

export const focusStop = (page: Page): Promise<FocusStop> => page.evaluate(() => {
  const element = document.activeElement as HTMLElement | null;
  if (!element || element === document.body) return { name: 'body', ring: false, covered: false, offscreen: false };
  const drawn = (target: Element, pseudo?: string) => {
    const look = getComputedStyle(target, pseudo);
    return (look.outlineStyle !== 'none' && Number.parseFloat(look.outlineWidth) > 0) || look.boxShadow !== 'none';
  };
  // A control drawn by its parent (a styled radio or checkbox) shows its ring on that parent; a link stretched
  // over its row draws it on its own ::after.
  const ring = drawn(element) || drawn(element, '::after') || drawn(element, '::before')
    || [element.parentElement, element.closest('label')].some(parent => !!parent && drawn(parent));
  const box = element.getBoundingClientRect();
  const offscreen = box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > innerHeight
    || box.right < 0 || box.left > innerWidth;
  // WCAG 2.4.11: a sticky bar must not hide the focused element. Look at the point that is most visible.
  const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  const covered = !offscreen && box.width > 1 && box.height > 1 && !!top && top !== element && !element.contains(top) && !top.contains(element)
    && !element.closest('label')?.contains(top);
  return { name: `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''}`.trim(),
    ring, covered, offscreen,
    ...covered && top ? { coveredBy: `${top.tagName.toLowerCase()}${top.className ? `.${String(top.className).trim().split(/\s+/).slice(0, 4).join('.')}` : ''} at ${Math.round(x)},${Math.round(y)} (the control is ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)})` } : {} };
});

/** Tab (then Shift+Tab, in case it lies behind) until `there` holds, noting every stop that shows no focus indicator or is hidden. */
async function walkTo(page: Page, there: () => Promise<boolean>, found: Findings, label: string, max: number): Promise<void> {
  const seen = new Set<string>();
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    for (let stop = 0; stop < max; stop += 1) {
      if (await there()) return;
      await page.keyboard.press(key);
      const focus = await focusStop(page);
      const id = `${focus.name}`;
      if (!focus.ring && focus.name !== 'body' && !seen.has(`ring ${id}`)) { seen.add(`ring ${id}`); found.push(`${label}: no focus indicator on ${id}`); }
      if (focus.covered && !seen.has(`cover ${id}`)) { seen.add(`cover ${id}`); found.push(`${label}: focus is hidden behind ${focus.coveredBy ?? 'another element'} on ${id}`); }
      if (await there()) return;
    }
  }
  throw new Error(`${label}: the keyboard could not reach the control (Tab and Shift+Tab, ${max} stops each)`);
}

/** Move to `target` with Tab and nothing else, noting every stop without a focus indicator or hidden behind something. */
export async function keyboardReach(page: Page, target: Locator, found: Findings, label: string, max = 120): Promise<void> {
  await walkTo(page, () => target.evaluate(element => element === document.activeElement || element.contains(document.activeElement))
    .catch(() => false), found, label, max);
}

/**
 * Choose one radio of a group as a keyboard does: Tab to the group (one stop, on its checked or first radio), then
 * the arrow keys to the one wanted. Throws when no arrow reaches it.
 */
export async function chooseRadio(page: Page, target: Locator, found: Findings, label: string): Promise<void> {
  const group = target.locator('xpath=ancestor::*[@role="radiogroup"][1]');
  await walkTo(page, () => group.evaluate(element => element.contains(document.activeElement)).catch(() => false), found, label, 120);
  const size = await group.getByRole('radio').count();
  for (let press = 0; press <= size && !await target.isChecked(); press += 1) await page.keyboard.press('ArrowDown');
  if (!await target.isChecked()) throw new Error(`${label}: the arrow keys never reached the radio`);
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
 * commit. Composition is driven through CDP, so Chromium only; WebKit gets the text as one input event, and WebKit's
 * own composition and the physical phones are checked by hand (docs/development/launch-accessibility.md).
 * Returns what the field held mid-composition and after the commit, and whether the composition's Enter submitted
 * the form or was swallowed by a key handler.
 */
export async function composeCjk(page: Page, field: Locator, text: string): Promise<{ value: string; duringComposition: string; submitted: boolean }> {
  if (page.context().browser()?.browserType().name() !== 'chromium') {
    // WebKit has no composition API: the text arrives as one input event, which still proves the field takes CJK text.
    await field.focus();
    await page.keyboard.insertText(text);
    const value = await field.inputValue();
    return { value, duringComposition: value, submitted: false };
  }
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
