import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { UnavailableClassificationsReader } from '../src/ratings/own-classifications/reader';
import type { OwnClassificationsRead } from '../src/ratings/own-classifications/actions';
import type { ClassificationFrontier } from '../src/ratings/own-classifications/types';
import { m } from '../src/paraglide/messages.js';
import {
  accountId,
  associationId,
  classificationRow,
  classificationsPage,
  frontier,
  subjectId,
} from './own-classification-assessments-fixture';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
const frames: FrameRequestCallback[] = [];
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
afterAll(() => {
  for (const [key, value] of previous)
    value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
  window.happyDOM.abort();
});

test('locale and exact selected frontier replacement retire inspection, continuation callbacks and delayed focus', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const page = classificationsPage(undefined, ' raw +/=%opaque ');
  const next: ClassificationFrontier[] = [];
  const render = (locale = 'en', address: ClassificationFrontier = frontier) =>
    root.render(
      <OwnClassificationsWorkspace
        state="ready"
        page={page}
        frontier={address}
        locale={locale}
        isCurrent={() => true}
        onRetry={async () => {}}
        onNext={(value) => next.push(value)}
      />,
    );
  try {
    await act(async () => render());
    const oldNext = [...host.querySelectorAll('button')].at(-1)!;
    await act(async () => host.querySelector('button')!.click());
    await act(async () => oldNext.click());
    expect(next).toEqual([{ cursor: page.next, selected: { subjectId, associationId } }]);
    const retiredFocus = frames.splice(0);
    await act(async () => render('ja'));
    expect(host.querySelector('section')).toBeNull();
    await act(async () => oldNext.click());
    expect(next).toHaveLength(1);
    await act(async () => host.querySelector('button')!.click());
    let focused = 0;
    host.querySelector('section')!.focus = () => {
      focused++;
    };
    retiredFocus.forEach((callback) => callback(0));
    expect(focused).toBe(0);
    await act(async () => render('ja', { cursor: 'other raw', selected: { subjectId, associationId } }));
    expect(host.querySelector('section')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('mounted unavailable admission fences late accounts and retries the original frontier once without history', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  const root = createRoot(host);
  const original = { cursor: ' raw +/=%opaque ', selected: { subjectId, associationId } };
  const initial: OwnClassificationsRead = {
    state: 'unavailable',
    page: null,
    subject: accountId,
    locale: 'en',
    frontier: original,
  };
  const calls: { frontier: ClassificationFrontier; resolve: (value: OwnClassificationsRead) => void }[] = [];
  const read = (address: ClassificationFrontier) =>
    new Promise<OwnClassificationsRead>((resolve) => calls.push({ frontier: address, resolve }));
  const render = (subject = accountId) =>
    root.render(
      <UnavailableClassificationsReader
        initial={initial}
        frontier={original}
        locale="en"
        subject={subject}
        state={null}
        isCurrent={() => true}
        read={read}
      />,
    );
  const reply = (
    subject: string,
    state: Exclude<OwnClassificationsRead['state'], 'ready'> = 'unavailable',
  ): OwnClassificationsRead => ({
    ...initial,
    subject,
    state,
  });
  try {
    await act(async () => render());
    expect(calls.map((call) => call.frontier)).toEqual([original]);
    await act(async () => calls[0]!.resolve(reply(accountId)));
    const oldRetry = host.querySelector('button')!;
    await act(async () => {
      oldRetry.click();
      oldRetry.click();
    });
    expect(calls).toHaveLength(2);
    await act(async () => render('account-b'));
    expect(calls).toHaveLength(3);
    await act(async () => calls[1]!.resolve(reply(accountId, 'moved-home')));
    expect(host.textContent).not.toContain(m.own_classifications_moved({}, { locale: 'en' }));
    await act(async () => calls[2]!.resolve(reply('account-b')));
    await act(async () => oldRetry.click());
    expect(calls).toHaveLength(3);
    await act(async () => host.querySelector('button')!.click());
    expect(calls[3]!.frontier).toEqual(original);
    await act(async () => calls[3]!.resolve({ ...reply('account-b', 'moved-home'), locale: 'ja' }));
    expect(host.textContent).toContain(m.own_classifications_unavailable({}, { locale: 'en' }));
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).not.toContain('Own-page subject');
    await act(async () => host.querySelector('button')!.click());
    await act(async () => root.unmount());
    await act(async () => calls[4]!.resolve(reply('account-b', 'moved-home')));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
  }
});

test('inspection retires on source replacement and old selection callbacks cannot revive it', async () => {
  const host = window.document.createElement('div') as HTMLElement;
  const root = createRoot(host);
  const page = classificationsPage();
  let active = true;
  const render = (currentPage = page) =>
    root.render(
      <OwnClassificationsWorkspace
        state="ready"
        page={currentPage}
        frontier={frontier}
        locale="en"
        isCurrent={() => active}
        onRetry={async () => {}}
        onNext={() => {}}
      />,
    );
  try {
    await act(async () => render());
    const old = host.querySelector('button')!;
    await act(async () => old.click());
    expect(host.querySelector('section')?.textContent).toContain('Original Subject and association');
    expect(
      [...host.querySelectorAll('a')].every(
        (link) => link.href.includes('/en/subjects/') && !link.href.includes('/v1/'),
      ),
    ).toBe(true);
    await act(async () => render(classificationsPage([classificationRow()])));
    expect(host.querySelector('section')).toBeNull();
    await act(async () => old.click());
    expect(host.querySelector('section')).toBeNull();
    active = false;
    await act(async () => render());
    expect(host.textContent).not.toContain('Own-page subject');
    expect(host.querySelector('a')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
