import { describe, expect, test } from 'bun:test';
import {
  EntityPickerSource,
  type EntityPickerItem,
  type EntityPickerPage,
} from '../../../packages/ui/src/components/entity-picker-state.ts';
import { entityPickerMessages } from '../../../packages/ui/src/components/entity-picker-messages.ts';
import { accountMenuSections } from '../features/auth/account-menu-items.ts';
import { messages } from '../features/auth/messages.ts';
import { uiLocales } from '../i18n/define.ts';
import type { Session } from '../features/auth/session.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const item = (value: string) => ({ value, label: value });
describe('G-941 asynchronous picker', () => {
  test('a late query cannot overwrite the current query or its loading state', async () => {
    const old = deferred<EntityPickerPage<EntityPickerItem>>();
    const current = deferred<EntityPickerPage<EntityPickerItem>>();
    const source = new EntityPickerSource(({ q }) => (q === 'old' ? old.promise : current.promise));
    const first = source.search('old');
    const second = source.search('银河');
    old.resolve({ items: [item('wrong')], nextCursor: null, complete: true });
    await first;
    expect(source.getSnapshot()).toMatchObject({ q: '银河', items: [], loading: true });
    current.resolve({ items: [item('right')], nextCursor: null, complete: true });
    await second;
    expect(source.getSnapshot()).toMatchObject({
      items: [item('right')],
      loading: false,
      complete: true,
    });
  });
  test('failed continuation keeps items and retries the same cursor; concurrent scroll events load once', async () => {
    const calls: (string | null)[] = [];
    const next = deferred<EntityPickerPage<EntityPickerItem>>();
    let failed = false;
    const source = new EntityPickerSource(async ({ cursor }) => {
      calls.push(cursor);
      if (!cursor) return { items: [item('a')], nextCursor: 'next', complete: false };
      if (!failed) {
        failed = true;
        return next.promise;
      }
      return { items: [item('a'), item('b')], nextCursor: null, complete: true };
    });
    await source.search('');
    const more = source.more();
    await source.more();
    expect(calls).toEqual([null, 'next']);
    next.reject(new Error('offline'));
    await more;
    expect(source.getSnapshot()).toMatchObject({
      items: [item('a')],
      nextCursor: 'next',
      error: true,
      complete: false,
    });
    await source.retry();
    expect(calls).toEqual([null, 'next', 'next']);
    expect(source.getSnapshot()).toMatchObject({
      items: [item('a'), item('b')],
      error: false,
      complete: true,
    });
    await source.more();
    expect(calls).toHaveLength(3);
  });
  test('cancelled loads and errors cannot publish; a nonprogressing page stays incomplete and retryable', async () => {
    const pending = deferred<EntityPickerPage<EntityPickerItem>>();
    const source = new EntityPickerSource(() => pending.promise);
    const request = source.search('a');
    source.cancel();
    pending.reject(new Error('gone'));
    await request;
    expect(source.getSnapshot().error).toBe(false);
    const broken = new EntityPickerSource(async () => ({
      items: [],
      nextCursor: null,
      complete: false,
    }));
    await broken.search('');
    expect(broken.getSnapshot()).toMatchObject({ complete: false, error: true });
  });
});
test('G-941 an empty unfinished page is traversed and retries its continuation, rather than starting over', async () => {
  const calls: (string | null)[] = [];
  let failed = false;
  const source = new EntityPickerSource(async ({ cursor }) => {
    calls.push(cursor);
    if (!cursor) return { items: [], nextCursor: 'scan-next', complete: false };
    if (!failed) {
      failed = true;
      throw new Error('Offline');
    }
    return { items: [item('found')], nextCursor: null, complete: true };
  });
  await source.search('');
  await source.more();
  await source.retry();
  expect(calls).toEqual([null, 'scan-next', 'scan-next']);
  expect(source.getSnapshot()).toMatchObject({
    items: [item('found')],
    complete: true,
    error: false,
  });
});
describe('G-941 shared menu and localized controls', () => {
  const session: Session = {
    user: { id: 'a' },
    agents: [],
    expiresAt: 'later',
    agent: {
      status: 'selected',
      agent: {
        iri: 'https://rezics.com/id/a',
        label: 'A',
        handle: 'aster',
        kind: 'person',
        path: 'direct-principal',
      },
    },
  };
  test('both menu renderers use the same destination order and content preferences open settings', () => {
    const sections = accountMenuSections(session, messages.en);
    expect(sections.flat().map((entry) => entry.id)).toEqual([
      'profile',
      'library',
      'studio',
      'notifications',
      'language',
      'appearance',
      'content-preferences',
      'settings',
    ]);
    expect(sections[0]![0]).toMatchObject({ href: '/@aster' });
    expect(sections[1]![2]).toMatchObject({ href: '/settings#reading', arrow: true });
  });
  test('each picker locale supplies all labels and preserves placeholder meaning', () => {
    for (const locale of uiLocales) {
      const copy = entityPickerMessages[locale];
      expect(Object.keys(copy)).toEqual(Object.keys(entityPickerMessages.en));
      for (const key of Object.keys(copy) as (keyof typeof copy)[]) {
        expect(copy[key].trim()).not.toBe('');
        expect(copy[key].match(/\{\w+\}/g)).toEqual(entityPickerMessages.en[key].match(/\{\w+\}/g));
      }
    }
  });
});
