import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import type {
  RelationEvidenceCandidate,
  RelationEvidenceRead,
  RelationEvidenceRequest,
} from '../src/features/pages/relation-evidence';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const target = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const close =
  '/en/subjects/journey-work/relations?node=appearances&streamProperty=ex:appearance&streamDirection=forward';

function candidate(
  id: string,
  revision: number,
  decision: RelationEvidenceCandidate['decision'],
  rank: RelationEvidenceCandidate['rank'],
): RelationEvidenceCandidate {
  return {
    id,
    revision,
    decision,
    rank,
    retracted: false,
    statement: {
      id,
      property: { id: 'ex:appearance', data_type: 'wikibase-item' },
      value: { type: 'value', content: target },
      qualifiers: [],
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/original' } },
          ],
        },
      ],
      rank,
    },
  } as unknown as RelationEvidenceCandidate;
}

test('evidence beyond the preview continues on its own window; a failed window keeps its rows and is not an end', async () => {
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
  const requests: RelationEvidenceRequest[] = [];
  const reads: RelationEvidenceRead[] = [
    {
      kind: 'ready',
      candidates: [candidate('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11', 1, 'accepted', 'preferred')],
      next: 'window-two',
    },
    { kind: 'failure', status: 400 },
    {
      kind: 'ready',
      candidates: [
        candidate('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11', 1, 'accepted', 'preferred'),
        candidate('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12', 2, 'rejected', 'deprecated'),
      ],
      next: null,
    },
  ];
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('../src/features/pages/relation-evidence', () => ({
    loadRelationEvidence: async ({ data }: { data: RelationEvidenceRequest }) => {
      requests.push(data);
      return reads.shift()!;
    },
  }));
  const [{ createRoot }, { RelationEvidencePane }, { m }, { setLocale }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/relation-evidence-pane'),
    import('../src/paraglide/messages.js'),
    import('../src/paraglide/runtime.js'),
  ]);
  const testingLibrary = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testingLibrary));
  setLocale('en', { reload: false });
  const options = { locale: 'en' as never };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  const flush = () =>
    act(async () => {
      await Bun.sleep(0);
    });
  // Each candidate's header line names its revision, decision and rank.
  const rows = () =>
    [...host.querySelectorAll('[data-slot="relation-evidence-candidate"] > p:first-child')].map(
      (row) => row.textContent,
    );
  const more = () => host.querySelector<HTMLButtonElement>('[data-slot="relation-evidence-more"]');
  try {
    await act(async () =>
      root.render(
        h(RelationEvidencePane, { subject, locale: 'en', reader: null, property: 'ex:appearance', target, close }),
      ),
    );
    await flush();
    expect(requests[0]).toMatchObject({ subject, property: 'ex:appearance', target });
    expect(rows()).toEqual([
      `Revision 1 · ${m.relation_evidence_accepted({}, options)} · ${m.candidate_rank_preferred({}, options)}`,
    ]);
    expect(host.querySelector('[data-slot="relation-evidence-candidate"]')?.textContent).toContain(
      'https://example.test/original',
    );
    expect(host.querySelector<HTMLAnchorElement>('[data-slot="relation-evidence-close"]')?.getAttribute('href')).toBe(
      close,
    );

    more()!.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(requests[1]).toMatchObject({ subject, target, cursor: 'window-two' });
    expect(rows()).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.changes_invalid({}, options));
    expect(more()).not.toBeNull();

    more()!.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(requests[2]).toMatchObject({ cursor: 'window-two' });
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain(
      `Revision 2 · ${m.relation_evidence_rejected({}, options)} · ${m.changes_rank_deprecated({}, options)}`,
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(more()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}, 30_000);
