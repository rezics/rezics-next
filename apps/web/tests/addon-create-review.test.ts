import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import type { StatementInput } from '../src/features/catalogue/statement-editor';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

function row(key: string, statement: StatementInput) {
  return { key, statement };
}
function urlFact(key: string, href: string, cite: string) {
  return row(key, {
    property: { id: 'schema:sameAs' },
    value: { type: 'value', content: href },
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: cite } },
          { property: { id: 'schema:url' }, value: { type: 'value', content: `${cite}/part` } },
          { property: { id: 'schema:url' }, value: { type: 'value', content: `${cite}/more` } },
        ],
      },
    ],
    rank: 'normal',
  });
}

test('add-on review addressing keeps captured holders and bounded reuse without native calls', async () => {
  const { addonBase, addonInitialDraft, addonType } = await import('../src/features/catalogue/addon-profile');
  const { addonCreateControl, captureAddonHolders } = await import('../src/features/catalogue/addon-create-address');
  const {
    addonAdmitCreatedReader,
    addonFactDrafts,
    addonIncludedBase,
    addonStructuredParts,
    applyAddonReuse,
    captureAddonReuse,
  } = await import('../src/features/catalogue/addon-create-review-model');
  const { reuseIsStale } = await import('../src/features/catalogue/reference-reuse');
  const { addonProfileFixture, addonWorkId } = await import('../src/kernel/fake/catalogue-addon-profile');
  const fixture = addonProfileFixture();
  const read = await fixture.transport.load({ work: addonWorkId });
  if (!read.ok) throw new Error('Expected add-on release');
  const baseline = fixture.calls.length;
  const factsId = 'facts-group';
  const facts = [
    urlFact('fact-a', 'https://example.org/a', 'https://example.org/a-cite'),
    urlFact('fact-b', 'https://example.org/b', 'https://example.org/b-cite'),
  ];
  const base = row('base-1', {
    property: { id: addonBase },
    value: { type: 'value', content: addonWorkId },
    qualifiers: [],
    references: [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/base' } }] },
    ],
    rank: 'normal',
  });
  const captured = captureAddonHolders(facts, base);
  const draft = addonInitialDraft(read.release, { type: addonType, labels: { en: 'Expansion' } }, [
    ...facts.map((item) => item.statement),
    base.statement,
  ]);
  expect(draft.errors).toEqual([]);
  expect(draft.item.statements[addonBase]?.[0]?.value).toEqual({ type: 'value', content: addonWorkId });
  expect(
    addonIncludedBase(draft.item.statements, { id: addonWorkId, type: 'schema:VideoGame', labels: { en: 'Harbor' } })
      ?.subject?.id,
  ).toBe(addonWorkId);
  expect(addonIncludedBase({}, { id: addonWorkId, type: 'schema:VideoGame', labels: {} })).toBeUndefined();
  expect(JSON.stringify(draft.item)).not.toContain('Harbor Studio');
  const nested = addonCreateControl(
    '/statements/schema:sameAs/0/references/0/parts/0/value/content',
    captured,
    facts,
    base,
    read.release,
    'en',
    factsId,
  );
  expect(nested?.id).toContain('game-initial-fact-a');
  expect(nested?.id).not.toBe(factsId);
  const basePointer = addonCreateControl(
    '/statements/wdt:P8646/0/value/content',
    captured,
    facts,
    base,
    read.release,
    'en',
    factsId,
  );
  expect(basePointer?.id).toContain('addon-base-base-1');
  const neighbour = facts[1]!;
  const afterRemoval = addonCreateControl(
    '/statements/schema:sameAs/0/references/0/parts/0/value/content',
    captured,
    [neighbour],
    base,
    read.release,
    'en',
    factsId,
  );
  expect(afterRemoval?.id).toBe('addon-removed-fact-a');
  expect(afterRemoval?.id).not.toContain(neighbour.key);
  expect(addonCreateControl('/statements', captured, facts, base, read.release, 'en', factsId)?.id).toBe(factsId);
  const reuse = captureAddonReuse(facts, 'fact-a', 0);
  expect(reuse).not.toBeNull();
  expect(reuseIsStale(reuse!.source, addonFactDrafts(facts), ['fact-b'], reuse!.capture)).toBe(false);
  expect(
    reuseIsStale(
      reuse!.source,
      addonFactDrafts([urlFact('fact-a', 'https://example.org/a', 'https://example.org/changed'), facts[1]!]),
      ['fact-b'],
      reuse!.capture,
    ),
  ).toBe(true);
  const copied = applyAddonReuse(facts, { ...reuse!, selected: ['fact-b'] }, read.release);
  expect(copied.applied).toEqual([{ holder: 'fact-b', property: 'schema:sameAs', index: 1 }]);
  expect(copied.facts[1]!.statement.references).toHaveLength(2);
  expect(copied.facts[1]!.statement.references[1]).toEqual(facts[0]!.statement.references[0]);
  expect(copied.facts[0]!.statement.references).toHaveLength(1);
  expect(
    addonAdmitCreatedReader(
      { state: 'ready', href: '/en/subjects/x', identity: { id: 'x', type: addonType, label: 'x' } },
      'x',
    ).state,
  ).toBe('ready');
  expect(
    addonAdmitCreatedReader(
      { state: 'ready', href: '/en/subjects/x', identity: { id: 'x', type: 'schema:VideoGame', label: 'x' } },
      'x',
    ).state,
  ).toBe('stale');
  const sizes = [32, 64, 128] as const;
  for (const size of sizes) {
    const rows = Array.from({ length: size / 4 }, (_, index) =>
      urlFact(`g-${index}`, `https://example.org/n/${index}`, `https://example.org/cite/${index}`),
    );
    const holders = captureAddonHolders(rows, undefined);
    const prepared = addonInitialDraft(
      read.release,
      { type: addonType, labels: { en: `Scale ${size}` } },
      rows.map((item) => item.statement),
    );
    expect(addonStructuredParts(prepared.item.statements)).toBe(size);
    let visited = 0;
    for (const [index] of rows.entries()) {
      const target = addonCreateControl(
        `/statements/schema:sameAs/${index}/references/0/parts/1/value/content`,
        holders,
        rows,
        undefined,
        read.release,
        'en',
        factsId,
      );
      expect(target?.id).toContain(`game-initial-g-${index}`);
      visited += 4;
    }
    expect(visited).toBe(size);
    const source = captureAddonReuse(rows, 'g-0', 0)!;
    const scaled = applyAddonReuse(
      rows,
      { ...source, selected: rows.slice(1, 17).map((item) => item.key) },
      read.release,
    );
    expect(scaled.applied.length + scaled.refused.length).toBe(Math.min(16, rows.length - 1));
    expect(fixture.calls.length - baseline).toBe(0);
  }
});
