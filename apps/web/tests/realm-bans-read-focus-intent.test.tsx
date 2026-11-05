import { expect, test } from 'bun:test';
import type { BanReadState } from '../src/community/realm-bans';
import { banReadHarness } from './realm-bans-read-harness';

const { host, outside, ready, props, paint, deferred, button, activate, settle, m, window } = await banReadHarness();

test('keyboard continuation focuses its result only after the deferred read', async () => {
  const read = deferred<BanReadState>();
  const cursors: (string | undefined)[] = [];
  await paint(props('one', ready('page-two'), (cursor) => (cursors.push(cursor), read.promise)));
  await activate(m.realm_bans_next());
  expect(cursors).toEqual(['page-two']);
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
  await settle(read, ready(null));
  expect(document.activeElement).toBe(host.querySelector('h2'));
});

test('pointer activation, later pointer, focus movement, and Tab cancel the handoff', async () => {
  const reads = Array.from({ length: 3 }, () => deferred<BanReadState>());
  let index = 0;
  await paint(props('one', ready('page-two'), () => reads[index++]!.promise));
  await activate(m.realm_bans_next(), 1);
  await settle(reads[0]!, ready('page-three'));
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
  await activate(m.realm_bans_next());
  document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  outside.focus();
  await settle(reads[1]!, ready('page-four'));
  expect(document.activeElement).toBe(outside);
  await activate(m.realm_bans_next());
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  outside.focus();
  await settle(reads[2]!, ready(null));
  expect(document.activeElement).toBe(outside);
});

test('a failed continuation focuses retry and preserves its exact cursor', async () => {
  const failed = deferred<BanReadState>();
  const retried = deferred<BanReadState>();
  const cursors: (string | undefined)[] = [];
  await paint(
    props('one', ready('page-two'), (cursor) => {
      cursors.push(cursor);
      return cursors.length === 1 ? failed.promise : retried.promise;
    }),
  );
  await activate(m.realm_bans_next());
  await settle(failed, { state: 'unavailable' });
  expect(document.activeElement).toBe(button(m.realm_bans_read_retry()));
  await activate(m.realm_bans_read_retry());
  expect(cursors).toEqual(['page-two', 'page-two']);
  await settle(retried, ready(null));
  expect(document.activeElement).toBe(host.querySelector('h2'));
});

test('an ABA caller replacement retires a deferred read focus intent', async () => {
  const oldRead = deferred<BanReadState>();
  const initial = ready('page-two');
  let reads = 0;
  const readA = () => (++reads === 1 ? oldRead.promise : Promise.resolve(ready(null)));
  const propsA = props('one', initial, readA);
  await paint(propsA);
  await activate(m.realm_bans_next());
  await paint(props('two', ready(null), async () => ready(null)));
  await paint(propsA);
  await settle(oldRead, ready(null));
  expect(reads).toBe(2);
  expect(document.activeElement).not.toBe(host.querySelector('h2'));
});

test('Previous, current Refresh and Restart focus only their newly admitted region', async () => {
  const reads = Array.from({ length: 4 }, () => deferred<BanReadState>());
  const cursors: (string | undefined)[] = [];
  await paint(props('one', ready('two'), (cursor) => (cursors.push(cursor), reads[cursors.length - 1]!.promise)));
  for (const [index, label] of [
    m.realm_bans_next(),
    m.realm_bans_refresh(),
    m.realm_bans_previous(),
    m.realm_bans_restart(),
  ].entries()) {
    await activate(label);
    expect(document.activeElement).not.toBe(host.querySelector('h2'));
    await settle(reads[index]!, ready('two'));
    expect(document.activeElement).toBe(host.querySelector('h2'));
  }
  expect(cursors).toEqual(['two', 'two', undefined, undefined]);
});

test('initial replacement fences late focus even when an equal page settles', async () => {
  const pending = deferred<BanReadState>();
  const same = ready('two');
  const read = () => pending.promise;
  await paint(props('one', same, read));
  await activate(m.realm_bans_next());
  await paint(props('one', ready(null), read));
  outside.focus();
  await settle(pending, same);
  expect(document.activeElement).toBe(outside);
  expect(button(m.realm_bans_next())).toBeUndefined();
});
