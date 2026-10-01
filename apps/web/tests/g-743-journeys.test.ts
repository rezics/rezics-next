import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { imeOnDevice, journeyProjects, launchJourneys, physicalDevices } from '../../../scripts/qa/cases/launch-journeys.ts';
import { locales, reflowWidths, sizes, themes } from './g-743-matrix.ts';

// G-743's guard: a launch journey that lacks a part of the accessibility matrix fails here, so adding a journey
// without its axe, keyboard, reduced-motion, phone and locale coverage (or dropping one from a file) is a red test.
const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * The test with this exact title, from its `test(` to the next top-level `test(`, together with the file's own
 * helper functions that it calls (a journey shared by its Latin and CJK runs lives in one).
 */
function body(source: string, title: string): string | null {
  const start = source.indexOf(`test('${title}'`);
  if (start < 0) return null;
  const next = source.indexOf('\ntest(', start + 1);
  const text = source.slice(start, next < 0 ? undefined : next);
  const helpers = [...source.matchAll(/\nasync function (\w+)\([\s\S]*?\n}\n/g)]
    .filter(([, name]) => new RegExp(`\\b${name}\\(`).test(text)).map(([whole]) => whole);
  return [text, ...helpers].join('\n');
}

const requiredJourneys = ['work-hub', 'library-import-progress-export', 'franchise-wiki', 'propose-review-inbox',
  'sign-up-with-policies', 'report-without-account'];

test('G-743 every launch journey in the brief is listed once', () => {
  expect(launchJourneys.map(journey => journey.id).sort()).toEqual([...requiredJourneys].sort());
});

test('G-743 the matrix covers both themes, a phone and a desktop width, and 200% and 400% zoom', () => {
  expect([...themes]).toEqual(['light', 'dark']);
  expect(sizes.phone.width).toBeLessThan(500);
  expect(sizes.desktop.width).toBeGreaterThanOrEqual(1024);
  // 1280 CSS px at 200% and 400% zoom (WCAG 1.4.10).
  expect([...reflowWidths]).toEqual([640, 320]);
  expect(locales.latin).toBe('en');
  expect(['ja', 'zh-Hans', 'zh-Hant']).toContain(locales.cjk);
});

for (const journey of launchJourneys) {
  test(`G-743 ${journey.id} has axe, themes, widths, reflow, keyboard, reduced motion and both locales`, () => {
    expect(existsSync(resolve(root, journey.spec)), journey.spec).toBe(true);
    const source = read(journey.spec);
    const latin = body(source, journey.latin);
    const cjk = body(source, journey.cjk);
    expect(latin, `${journey.id}: no test titled "${journey.latin}" in ${journey.spec}`).not.toBeNull();
    expect(cjk, `${journey.id}: no test titled "${journey.cjk}" in ${journey.spec}`).not.toBeNull();
    // Screens go through the matrix (axe, themes, phone and desktop widths, reflow); the result is asserted.
    for (const [which, text] of [['Latin', latin!], ['CJK', cjk!]] as const) {
      expect(text, `${journey.id} ${which}: checkScreen`).toContain('checkScreen(');
      expect(text, `${journey.id} ${which}: expectClean`).toContain('expectClean(found)');
    }
    expect(latin, `${journey.id} Latin: locales.latin`).toContain('locales.latin');
    expect(cjk, `${journey.id} CJK: locales.cjk`).toContain('locales.cjk');
    // Keyboard-only use with the focus indicator checked, and reduced motion, in the Latin run.
    expect(latin, `${journey.id}: keyboard`).toMatch(/keyboardReach\(|pressByKeyboard\(/);
    expect(latin, `${journey.id}: reduced motion context`).toContain('reducedMotion: true');
    expect(latin, `${journey.id}: reduced motion is asserted`).toContain('motionRunning(');
    // And the CJK run reaches a control by keyboard too.
    expect(cjk, `${journey.id}: keyboard in CJK`).toMatch(/keyboardReach\(|pressByKeyboard\(/);
  });
}

for (const journey of launchJourneys.filter(item => item.ime)) {
  test(`G-743 ${journey.id} writes its text fields with CJK IME composition`, () => {
    const text = body(read(journey.spec), journey.ime!);
    expect(text, `${journey.id}: no test titled "${journey.ime}"`).not.toBeNull();
    expect(text).toContain('composeCjk(');
    expect(text, 'composition must not submit').toContain('composed.submitted');
  });
}

test('G-743 the journey with a proposal form and a review composer writes both with IME composition and has a physical check', () => {
  const contribute = launchJourneys.find(journey => journey.id === 'propose-review-inbox')!;
  const source = read(contribute.spec);
  expect(body(source, contribute.latin)).toContain('composeCjk(');
  expect(body(source, contribute.ime!)).toContain('composeCjk(');
  expect(Object.keys(imeOnDevice)).toEqual(['propose-review-inbox']);
});

test('G-743 the Playwright config runs the journeys in Chromium desktop, Chromium mobile and WebKit mobile', () => {
  const config = read('apps/web/playwright.config.ts');
  for (const project of journeyProjects) expect(config, project).toContain(`'${project}'`);
  // The journeys alone take the mobile projects; every other file keeps running once.
  expect(config).toMatch(/g-743-\[\\w-\]\+\\\.e2e\\\.ts/);
});

test('G-743 each physical phone and its screen reader are assigned a different journey that exists', () => {
  const ids = new Set(launchJourneys.map(journey => journey.id));
  expect(physicalDevices.map(item => item.device)).toEqual(['iPhone', 'Android phone']);
  const assigned = physicalDevices.map(item => item.screenReaderJourney);
  expect(new Set(assigned).size).toBe(assigned.length);
  for (const journey of assigned) expect(ids.has(journey), journey).toBe(true);
});
