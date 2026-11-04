import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import type { Release } from '@rezics/definitions';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import type { FactsCurrent } from '../src/features/catalogue/subject-facts';
import recorded from '../src/kernel/recorded/definitions-release.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('specialist and publication reviews retain reference meaning, group order and exact edit addresses without changing prepared operands', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/literary' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { AlbumCreateReview } = await import('../src/features/catalogue/album-create-review');
  const { CharacterCreateReview } = await import('../src/features/catalogue/character-create-review');
  const { PeopleCreateReview } = await import('../src/features/catalogue/people-create-review');
  const { LiteraryCreateReview } = await import('../src/features/catalogue/literary-create-review-view');
  const { ScreenCreateReview } = await import('../src/features/catalogue/screen-create-review-view');
  const { AddonCreateReview } = await import('../src/features/catalogue/addon-create-review');
  const { PublicationReview } = await import('../src/features/catalogue/publication-editor-review');
  const { FactsChangedReview } = await import('../src/features/catalogue/subject-facts-review');
  const { publicationProfiles } = await import('../src/features/catalogue/publication-editor');
  const { literaryFixture } = await import('../src/kernel/fake/catalogue-literary-profile');
  const { statementInput } = await import('../src/features/catalogue/statement-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const o = { locale: 'ja' as const };
  const release = structuredClone(recorded.release) as Release;
  release.properties['schema:url']!.labels = { en: 'Evidence URL' };
  release.properties['schema:name']!.labels = { en: 'Evidence title' };
  const part = (property: string, content: string) => ({
    property: { id: property },
    value: { type: 'value' as const, content },
  });
  const assertion: StatementInput = {
    ...part('schema:url', 'https://example.org/same'),
    rank: 'preferred',
    qualifiers: [part('schema:name', 'same'), part('schema:name', 'same')],
    references: [
      { parts: [part('schema:url', 'https://example.org/same'), part('schema:name', 'same')] },
      { parts: [] },
      {
        parts: [
          part('schema:name', 'same'),
          { property: { id: 'schema:name' }, value: { type: 'somevalue' } },
          { property: { id: 'schema:name' }, value: { type: 'novalue' } },
          part('external:unreleased-property', 'kept operand'),
        ],
      },
    ],
  };
  const item = freeze({
    type: 'schema:Book',
    labels: { en: 'Captured subject' },
    statements: { 'schema:url': [assertion, structuredClone(assertion)] },
  });
  const command = freeze({ key: 'original-prepared-key', item });
  const before = JSON.stringify(command);
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const jumps: (string | number)[] = [];
  const jump = (target: string | number) => {
    jumps.push(target);
  };
  const shared = { item, release, locale: 'ja', stale: false };
  const factId = (property: string, index: number) => `retained-${property}-${index}`;
  async function render(node: ReactNode) {
    jumps.length = 0;
    await act(async () => root.render(node));
  }
  async function clickAll() {
    for (const button of host.querySelectorAll<HTMLButtonElement>('button')) {
      expect(button.type).toBe('button');
      await act(async () => button.click());
    }
  }
  function evidence(sanitized = false) {
    const summaries = [...host.querySelectorAll('dl')];
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const dl of summaries) {
      if (dl.querySelector('code')?.textContent !== 'schema:url') continue;
      expect(dl.querySelector('dt')?.textContent).toBe('Evidence URL');
      expect(dl.querySelector('dt')?.getAttribute('lang')).toBe('en');
      expect(dl.querySelectorAll('dt')).toHaveLength(3);
      const summary = dl.parentElement!;
      const groups = [...summary.querySelectorAll(':scope > ol > li')];
      expect(groups).toHaveLength(sanitized ? 2 : 3);
      expect(groups[0]!.querySelector('p')?.textContent).toBe(`${m.correction_references({}, o)} 1`);
      const meanings = [...groups[0]!.querySelectorAll('li > span[lang]')].map((label) => label.textContent);
      expect(meanings).toEqual(['Evidence URL: ', 'Evidence title: ']);
      expect(groups[0]!.querySelectorAll('li > span[lang="en"]')).toHaveLength(2);
      if (!sanitized) expect(groups[1]!.textContent).toContain(m.facts_reuse_empty({}, o));
      const last = groups.at(-1)!;
      expect(last.textContent).toContain('external:unreleased-property');
      expect(last.textContent).toContain(m.candidate_value_unavailable({}, o));
      expect(last.querySelectorAll('li')).toHaveLength(4);
      expect(last.textContent).toContain(m.subject_value_unknown({}, o));
      expect(last.textContent).toContain(m.subject_value_none({}, o));
      expect(summary.lastElementChild?.textContent).toBe(m.candidate_rank_preferred({}, o));
    }
    expect(JSON.stringify(command)).toBe(before);
  }
  try {
    await render(
      <AlbumCreateReview
        {...shared}
        rows={[
          { id: 'album-first', statement: assertion },
          { id: 'album-second', statement: assertion },
        ]}
        onJumpTerm={jump}
        onJumpFact={jump}
        onBack={() => jump('back')}
      />,
    );
    evidence(true);
    await clickAll();
    expect(jumps).toEqual(['en', 'album-first', 'album-second', 'back']);

    await render(
      <CharacterCreateReview
        {...shared}
        facts={[
          { id: 71, fact: assertion },
          { id: 19, fact: assertion },
        ]}
        onJumpTerm={jump}
        onJumpFact={jump}
        onBack={() => jump('back')}
      />,
    );
    evidence(true);
    await clickAll();
    expect(jumps).toEqual(['en', 71, 19, 'back']);

    await render(
      <PeopleCreateReview
        item={item}
        read={{ ok: true, release, public: null, work: null, profiles: [], credits: [] }}
        locale="ja"
        stale={false}
        onJump={jump}
      />,
    );
    evidence();
    await clickAll();
    expect(jumps).toEqual(['create-type', 'create-label-0', 'people-fact-schema:url']);

    for (const Review of [LiteraryCreateReview, ScreenCreateReview]) {
      await render(<Review {...shared} onJump={jump} factId={factId} />);
      evidence();
      await clickAll();
      expect(jumps).toEqual(['create-type', 'create-label-0', 'retained-schema:url-0', 'retained-schema:url-1']);
    }
    await render(
      <AddonCreateReview
        {...shared}
        captured={[
          { kind: 'fact', key: 'second-captured', property: 'schema:url' },
          { kind: 'fact', key: 'first-captured', property: 'schema:url' },
        ]}
        suggested={null}
        chosen={undefined}
        factsId="all-facts"
        onJump={jump}
      />,
    );
    evidence();
    await clickAll();
    expect(jumps).toEqual([
      'create-type',
      'create-label-0',
      'game-initial-second-captured-fact',
      'game-initial-first-captured-fact',
    ]);

    const read = { release, source: null, public: { related: {}, subject: { type: item.type } } };
    await render(
      <PublicationReview
        id="edition"
        item={{
          ...item,
          statements: {
            ...item.statements,
            'schema:exampleOfWork': [{ ...part('schema:exampleOfWork', 'original-work'), references: [] }],
          },
        }}
        profile={publicationProfiles(release, item.type, 'en')[0]!}
        relation="schema:exampleOfWork"
        terms={[{ id: 42, language: 'en', label: 'Captured subject', description: '', aliases: '' }]}
        facts={[
          { key: 'fact-b', statement: assertion },
          { key: 'fact-a', statement: assertion },
        ]}
        read={read}
        locale="ja"
        onEdit={jump}
      />,
    );
    evidence();
    await clickAll();
    expect(jumps).toEqual(['edition-label-42', 'edition-work-link', 'edition-fact-fact-b', 'edition-fact-fact-a']);

    const publicRead = literaryFixture().publicRead();
    const native = (id: string, rank: 'normal' | 'deprecated') => ({
      ...structuredClone(assertion),
      id,
      rank,
      qualifiers: assertion.qualifiers!.map((part) => ({
        ...part,
        property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
      })),
      property: { id: 'schema:url', data_type: 'url' },
      references: assertion.references.map((group, index) => ({
        hash: String(index),
        parts: group.parts.map((part) => ({
          ...part,
          property: { ...part.property, data_type: release.properties[part.property.id]?.datatype ?? 'string' },
        })),
      })),
      rezics: { release: recorded.digest, revision: 1 },
    });
    const current: FactsCurrent = {
      ok: true,
      release,
      source: null,
      public: {
        ...publicRead,
        subject: {
          ...publicRead.subject,
          statements: {
            'schema:url': [native('equal-decoy', 'normal'), native('exact-source', 'deprecated')],
          },
        },
      },
    };
    const drafts = freeze([
      { holder: 'holder-b', property: 'schema:url', source: 'exact-source', baseline: assertion, statement: assertion },
      { holder: 'holder-a', property: 'schema:url', source: null, baseline: null, statement: assertion },
    ]);
    const captured = JSON.stringify({ current, drafts });
    await render(<FactsChangedReview items={drafts} read={current} locale="ja" stale onJump={jump} />);
    const columns = [...host.querySelectorAll('section[aria-label]')];
    const old = columns.filter((column) => column.getAttribute('aria-label') === m.facts_review_current({}, o));
    const proposed = columns.filter((column) => column.getAttribute('aria-label') === m.facts_review_proposed({}, o));
    expect(old).toHaveLength(2);
    expect(proposed).toHaveLength(2);
    expect(old[0]!.textContent).toContain(m.changes_rank_deprecated({}, o));
    expect(old[0]!.textContent).not.toContain(m.candidate_rank_normal({}, o));
    expect(old[1]!.textContent).toContain(m.facts_no_value({}, o));
    expect(old[1]!.querySelector('dl')).toBeNull();
    expect(proposed.every((column) => column.textContent?.includes(m.candidate_rank_preferred({}, o)))).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.facts_review_stale({}, o));
    await clickAll();
    expect(jumps).toEqual(['holder-b', 'holder-a']);
    expect(JSON.stringify({ current, drafts })).toBe(captured);
    expect(statementInput(current.public.subject.statements['schema:url']![1]!).rank).toBe('normal');
    expect(JSON.stringify(command)).toBe(before);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
