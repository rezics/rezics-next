import { expect, test } from 'bun:test';
import { waitForFocus } from '../../../packages/ui/src/test/focus.ts';

function focusFixture() {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let deadline: (() => void) | undefined;
  const inside = {};
  const document = {
    activeElement: null as unknown,
    defaultView: {
      requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextId, callback); return nextId; },
      cancelAnimationFrame(id: number) { frames.delete(id); },
      setTimeout(callback: () => void) { deadline = callback; return ++nextId; },
      clearTimeout() { deadline = undefined; },
    },
  };
  const target = { ownerDocument: document, contains: (element: unknown) => element === inside } as unknown as HTMLElement;
  return {
    target, document, inside, frames,
    expire() { deadline!(); },
    hasDeadline() { return deadline !== undefined; },
    frame() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    },
  };
}

test('G958: overlay presence and transient autofocus do not permit keyboard input', async () => {
  const fixture = focusFixture();
  let ready = false;
  const waiting = waitForFocus(fixture.target).then(() => { ready = true; });
  fixture.frame();
  await Promise.resolve();
  expect(ready).toBe(false);
  fixture.document.activeElement = fixture.inside;
  fixture.frame();
  await Promise.resolve();
  expect(ready).toBe(false);
  // A scheduled focus move steals initial autofocus; readiness starts over.
  fixture.document.activeElement = {};
  fixture.frame();
  fixture.document.activeElement = fixture.inside;
  fixture.frame();
  await Promise.resolve();
  expect(ready).toBe(false);
  fixture.frame();
  await waiting;
  expect(ready).toBe(true);
  expect(fixture.frames.size).toBe(0);
  expect(fixture.hasDeadline()).toBe(false);
});

test('G958: missing focus fails and cancels the pending frame', async () => {
  const fixture = focusFixture();
  const waiting = waitForFocus(fixture.target);
  fixture.frame();
  fixture.expire();
  await expect(waiting).rejects.toThrow('Focus did not settle inside the target');
  expect(fixture.frames.size).toBe(0);
});

test('G958: a detached focus target fails without scheduling work', async () => {
  const target = { ownerDocument: { defaultView: null } } as unknown as HTMLElement;
  await expect(waitForFocus(target)).rejects.toThrow('Focus target has no window');
});
