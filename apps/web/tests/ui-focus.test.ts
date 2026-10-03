import { expect, test } from 'bun:test';
import { focusForTyping, waitForFocus } from '../../../packages/ui/src/test/focus.ts';

/** Control frame order without a DOM: these are the focus transitions that lose typed keys. */
function focusJourney() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const document = { activeElement: null as Element | null, defaultView: {
    setTimeout, clearTimeout,
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++next, callback); return next; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  } };
  const control = () => ({ ownerDocument: document, isConnected: true,
    contains(active: unknown) { return active === this; },
    focus() { document.activeElement = this as unknown as Element; }, outerHTML: '<input>' }) as unknown as HTMLElement;
  const input = control(), other = control();
  const overlay = { ...control(), contains: (active: unknown) => active === other } as HTMLElement;
  return { document, input, other, overlay, async frame(active: HTMLElement | null) {
    document.activeElement = active;
    const ready = [...frames.values()];
    frames.clear();
    for (const callback of ready) callback(0);
    await Promise.resolve();
  } };
}

test('typing waits through transient autofocus and a focus return before it settles on the input', async () => {
  const journey = focusJourney();
  let settled = false;
  const waiting = waitForFocus(journey.input).then(() => { settled = true; });
  await journey.frame(journey.input);
  await journey.frame(journey.other);
  await journey.frame(journey.input);
  expect(settled).toBe(false);
  await journey.frame(journey.input);
  await waiting;
  expect(settled).toBe(true);
});

test('an explicitly accepted combobox input may hold focus outside its overlay', async () => {
  const journey = focusJourney();
  const waiting = waitForFocus([journey.overlay, journey.input]);
  await journey.frame(journey.input);
  await journey.frame(journey.input);
  await waiting;
});

test('focus moving between accepted input and overlay must settle on one element', async () => {
  const journey = focusJourney();
  let settled = false;
  const waiting = waitForFocus([journey.overlay, journey.input]).then(() => { settled = true; });
  await journey.frame(journey.other);
  await journey.frame(journey.input);
  expect(settled).toBe(false);
  await journey.frame(journey.input);
  await waiting;
});

test('unrelated focus cannot satisfy the wait', async () => {
  const journey = focusJourney();
  const waiting = expect(waitForFocus(journey.input, 10)).rejects.toThrow('Focus did not settle');
  await journey.frame(journey.other);
  await journey.frame(journey.other);
  await waiting;
});

test('typing restores the chosen input after a delayed modal move, then waits for stable focus', async () => {
  const journey = focusJourney();
  let settled = false;
  const waiting = focusForTyping(journey.input).then(() => { settled = true; });
  await journey.frame(journey.other);
  expect(journey.document.activeElement).toBe(journey.input);
  await journey.frame(journey.input);
  expect(settled).toBe(false);
  await journey.frame(journey.input);
  await waiting;
});
