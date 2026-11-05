import { expect, test } from 'bun:test';
import { act } from 'react';
import { setup } from './public-realms-window-navigation.test';
import { m } from '../src/paraglide/messages.js';

test('failed Previous and cursor-free First retry the requested coordinate without false history; preparing and expired recovery remain truthful', async () => {
  const app = await setup();
  try {
    await app.click(m.public_account_next());
    await app.click(m.public_account_next());
    const coordinates = [...app.visit().coordinates];
    app.state(503);
    await app.click(m.music_context_previous_page(), true);
    expect(app.visit().coordinates).toEqual(coordinates);
    expect(app.host.querySelector('button')?.textContent).toBe(m.public_account_retry());
    expect(app.host.querySelector('article')).not.toBe(app.host.ownerDocument.activeElement);
    app.state(200);
    await app.click(m.public_account_retry());
    expect(app.calls.slice(-2)).toEqual(['c1', 'c1']);
    expect(app.visit().coordinates).toEqual([undefined, 'c1']);
    app.state(503);
    await app.click(m.public_account_start_again());
    expect(app.visit().coordinates).toEqual([undefined, 'c1']);
    app.state(200);
    await app.click(m.public_account_retry());
    expect(app.calls.slice(-2)).toEqual([null, null]);
    expect(app.visit().coordinates).toEqual([undefined]);
    app.state(202);
    await app.click(m.public_account_next());
    expect(app.host.textContent).toContain(m.public_account_preparing());
    expect(app.host.textContent).not.toContain('Loading');
    app.state(400);
    await act(async () => {
      await app.router.invalidate();
    });
    expect(app.host.textContent).toContain(m.public_account_cursor_expired());
    expect(app.link(m.public_account_start_again())).toBeDefined();
    expect(app.link(m.public_account_next())).toBeUndefined();
    app.state(200);
    await app.click(m.public_account_start_again());
    expect(app.calls.at(-1)).toBeNull();
  } finally {
    await app.close();
  }
});

test('later direct entry, equal-address replacement, ignored cancellation and moved focus cannot resurrect retired history or transfer focus', async () => {
  const app = await setup('/en/@mira/realms?cursor=c7&keep=%2f#reading');
  try {
    expect(app.link(m.music_context_previous_page())).toBeUndefined();
    expect(app.link(m.public_account_start_again())).toBeDefined();
    const first = app.visit();
    await act(async () => {
      await app.router.invalidate();
    });
    expect(first.active).toBe(false);
    expect(first.coordinates).toEqual([]);
    const second = app.visit();
    await act(async () => {
      await app.router.invalidate();
    });
    expect(second.active).toBe(false);
    expect(app.visit()).not.toBe(first);
    const release = app.hold();
    await app.click(m.public_account_next(), true);
    const outside = app.host.ownerDocument.createElement('button');
    app.host.ownerDocument.body.append(outside);
    outside.focus();
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(app.host.ownerDocument.activeElement).toBe(outside);
    expect(app.visit().coordinates).toEqual(['c7', 'c8']);
    const late = app.hold();
    await app.click(m.public_account_next());
    const retired = app.visit();
    await act(async () => {
      await app.router.navigate({ href: '/en/@mira/realms?cursor=c2' });
    });
    await act(async () => {
      late();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(retired.active).toBe(false);
    expect(app.visit().coordinates).toEqual(['c2']);
    expect(app.link(m.music_context_previous_page())).toBeUndefined();
    app.publish(false);
    const calls = app.calls.length;
    await act(async () => {
      await app.router.invalidate();
    });
    expect(app.calls).toHaveLength(calls);
    expect(app.link('Current Realm')).toBeUndefined();
    outside.remove();
  } finally {
    await app.close();
  }
});
