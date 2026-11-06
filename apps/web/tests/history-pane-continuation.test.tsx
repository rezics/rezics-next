import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import type { RelationHistorySelection } from '../src/features/pages/subject-history';
import type { SubjectHistoryRead, SubjectHistoryRequest } from '../src/features/pages/subject-history-reading';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const selection: RelationHistorySelection = {
  subject,
  label: 'Journey work',
  locale: 'en',
  view: 'relations',
  node: 'appearances',
  property: 'ex:appearance',
  direction: 'forward',
  cursor: 'page-two',
};

test('history continues from its own cursor, drops a repeated boundary row and never reads a failure as the end', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/work/relations', width: 390 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const requests: SubjectHistoryRequest[] = [];
  const reads: SubjectHistoryRead[] = [
    {
      kind: 'ready',
      revisions: [
        { revision: 1, kind: 'create' },
        { revision: 2, kind: 'propose' },
      ],
      next: 'history-two',
    },
    // A rejected continuation is unavailable history: the rows stay and the continuation stays.
    { kind: 'failure', status: 400 },
    {
      kind: 'ready',
      revisions: [
        { revision: 2, kind: 'propose' },
        { revision: 3, kind: 'accept' },
      ],
      next: null,
    },
  ];
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/features/pages/subject-history-reading', () => ({
    loadSubjectHistory: async ({ data }: { data: SubjectHistoryRequest }) => {
      requests.push(data);
      return reads.shift()!;
    },
  }));
  const [{ createRoot }, { RelationHistoryPane }, { m }, { setLocale }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/relation-history-pane'),
    import('../src/paraglide/messages.js'),
    import('../src/paraglide/runtime.js'),
  ]);
  const testingLibrary = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testingLibrary));
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  const flush = () =>
    act(async () => {
      await Bun.sleep(0);
    });
  const rows = () =>
    [...host.querySelectorAll('[data-slot="subject-history-revisions"] li')].map((row) => row.textContent);
  const more = () => host.querySelector<HTMLButtonElement>('[data-slot="subject-history-more"]');
  try {
    await act(async () => root.render(h(RelationHistoryPane, { selection, reader: null })));
    await flush();
    expect(requests[0]).toEqual({ subject, locale: 'en', reader: null });
    expect(rows()).toEqual(['Revision 1 create', 'Revision 2 propose']);
    expect(host.querySelector('[data-slot="subject-history-stream"]')?.textContent).toContain('appearances');
    expect(host.querySelector('[data-slot="subject-history-stream"]')?.textContent).not.toContain('page-two');

    more()!.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(requests[1]).toMatchObject({ subject, cursor: 'history-two' });
    expect(rows()).toEqual(['Revision 1 create', 'Revision 2 propose']);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.changes_invalid({}, { locale: 'en' as never }));
    expect(more()).not.toBeNull();

    more()!.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(requests[2]).toMatchObject({ subject, cursor: 'history-two' });
    expect(rows()).toEqual(['Revision 1 create', 'Revision 2 propose', 'Revision 3 accept']);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(more()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
