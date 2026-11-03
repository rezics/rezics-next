import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  dateReading,
  isReleaseType,
  RELEASE_ASSOCIATION_LIMIT,
  RELEASE_VISIT_CAPS,
  RELEASE_VISIT_COMPONENTS,
  visitBound,
} from '../src/features/catalogue/release-fidelity/model';
import { ReleaseFidelityEntry } from '../src/features/catalogue/release-fidelity/entry';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import {
  basedOnProperty,
  releaseAlt,
  releaseFidelityFixture,
  releaseSubject,
  releaseWork,
  replacedByProperty,
} from '../src/kernel/fake/release-fidelity';
import { m } from '../src/paraglide/messages.js';

const digest = 'sha256:current';
const timeStatement = (
  value: Parameters<typeof dateReading>[0] extends (infer Item)[] | undefined ? Item['value'] : never,
) =>
  [
    {
      id: '00000000-0000-4000-8000-00000000a114',
      rank: 'normal' as const,
      property: { id: 'schema:datePublished', data_type: 'time' as const },
      value,
      qualifiers: [],
      references: [],
      rezics: { release: digest, revision: 1 },
    },
  ];

test('TBA, partial, exact and absent dates stay distinct, and year zero is not TBA', () => {
  expect(dateReading(undefined, 'schema:datePublished', digest, 'en')).toMatchObject({ kind: 'absent' });
  expect(dateReading(timeStatement({ type: 'somevalue' }), 'schema:datePublished', digest, 'en')).toMatchObject({
    kind: 'tba',
  });
  expect(dateReading(timeStatement({ type: 'novalue' }), 'schema:datePublished', digest, 'en')).toMatchObject({
    kind: 'none',
  });
  expect(
    dateReading(
      timeStatement({ type: 'value', content: { time: '+2004-00-00T00:00:00Z', precision: 9 } }),
      'schema:datePublished',
      digest,
      'en',
    ),
  ).toMatchObject({ kind: 'partial', precision: 'year', text: '2004' });
  expect(
    dateReading(
      timeStatement({ type: 'value', content: { time: '+2004-10-15T00:00:00Z', precision: 11 } }),
      'schema:datePublished',
      digest,
      'en',
    ),
  ).toMatchObject({ kind: 'exact', precision: 'day' });
  expect(
    dateReading(
      timeStatement({ type: 'value', content: { time: '+0000-01-01T00:00:00Z', precision: 11 } }),
      'schema:datePublished',
      digest,
      'en',
    ).kind,
  ).toBe('exact');
});

test('a concrete edition shows work identity, language edition, two directed relations and historical meaning', async () => {
  const fixture = releaseFidelityFixture('ready');
  const page = await fixture.read();
  if (!page.ok) throw new Error('Expected a release page');
  expect(isReleaseType(page.release, 'bf:Instance')).toBe(true);
  expect(page.work).toMatchObject({ id: releaseWork, readability: 'readable' });
  expect(page.date.kind).toBe('exact');
  expect(page.facts.identifiers?.some((fact) => fact.property === 'schema:isbn')).toBe(true);
  expect(page.streams.map((stream) => stream.property).sort()).toEqual([basedOnProperty, replacedByProperty].sort());
  const based = page.streams.find((stream) => stream.property === basedOnProperty)!;
  const related = await fixture.read(based.key);
  if (!related.ok) throw new Error('Expected related releases');
  expect(related.rows[0]?.readability).toBe('readable');
  expect(related.rows[0]?.provenance).toContain('anidb:rel:9999');
  expect(related.rows[1]?.historical).toBe(true);
  const replaced = await fixture.read(page.streams.find((stream) => stream.property === replacedByProperty)!.key);
  expect(replaced.ok && replaced.stream?.property).toBe(replacedByProperty);
  expect(page.statusProperty).toBeUndefined();
  expect(page.regionProperty).toBeUndefined();
});

test('partial date, TBA, absent date, unreadable work and a concept that is not a release stay distinct', async () => {
  const partial = await releaseFidelityFixture('partial-date').read();
  expect(partial.ok && partial.date.kind).toBe('partial');
  const tba = await releaseFidelityFixture('tba').read();
  expect(tba.ok && tba.date.kind).toBe('tba');
  const absent = await releaseFidelityFixture('absent-date').read();
  expect(absent.ok && absent.date.kind).toBe('absent');
  const unread = await releaseFidelityFixture('unreadable-work').read();
  expect(unread.ok && unread.work.readability).toBe('unreadable');
  const concealed = await releaseFidelityFixture('concealed-work').read();
  expect(concealed.ok && concealed.work.readability).toBe('concealed');
  expect(await releaseFidelityFixture('not-release').read()).toEqual({ ok: false, reason: 'invalid' });
  expect(await releaseFidelityFixture('denied').read()).toEqual({ ok: false, reason: 'denied' });
});

test('selected detail is one listed related subject; independent detail failure keeps the page', async () => {
  const fixture = releaseFidelityFixture('ready');
  const page = await fixture.read(`forward:${basedOnProperty}`, undefined, releaseAlt);
  if (!page.ok) throw new Error('Expected selected detail');
  expect(page.detail?.subject.id).toBe(releaseAlt);
  expect(page.visit.calls).toBe(4);
  expect(page.visit.components.map((item) => item.id)).toEqual(['descriptor', 'subject', 'association', 'detail']);
  expect(await fixture.read(`forward:${basedOnProperty}`, undefined, releaseSubject)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  fixture.setScenario('detail-unavailable');
  const recovered = await fixture.read(`forward:${basedOnProperty}`, undefined, releaseAlt);
  expect(recovered.ok && recovered.rows.length).toBeGreaterThan(0);
  expect(recovered.ok && recovered.detail).toBeUndefined();
});

test('stale correction keeps the original statement and exact command key', async () => {
  const fixture = releaseFidelityFixture('stale');
  expect(await fixture.read()).toEqual({ ok: false, reason: 'stale' });
  const ready = releaseFidelityFixture('ready');
  ready.setScenario('stale');
  const key = '00000000-0000-4000-8000-00000000a180';
  const command = {
    id: releaseSubject,
    key,
    statement: {
      property: { id: 'schema:isbn' },
      value: { type: 'value' as const, content: '978-4-00-000001-7' },
      qualifiers: [],
      references: [],
      rank: 'normal' as const,
    },
  };
  expect(await ready.propose(command)).toMatchObject({ ok: false, reason: 'stale' });
  expect(ready.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
    `/v1/subjects/${releaseSubject}/candidates`,
  ]);
});

test('visit work stays page-bounded at 32, 256 and 2048 related releases', async () => {
  const bound = visitBound();
  expect(RELEASE_VISIT_COMPONENTS).toBe(4);
  expect(bound.rows).toBe(
    RELEASE_VISIT_CAPS.descriptor.rows +
      RELEASE_VISIT_CAPS.subject.rows +
      RELEASE_VISIT_CAPS.association.rows +
      RELEASE_VISIT_CAPS.detail.rows,
  );
  const firstPages: number[] = [];
  const firstBytes: number[] = [];
  for (const scale of [32, 256, 2048]) {
    const fixture = releaseFidelityFixture('ready', 'en', scale);
    const first = await fixture.read(`forward:${basedOnProperty}`);
    if (!first.ok) throw new Error(`Expected first page at ${scale}`);
    expect(first.rows).toHaveLength(RELEASE_ASSOCIATION_LIMIT);
    expect(first.visit.calls).toBe(3);
    expect(first.visit.rows).toBeLessThanOrEqual(bound.rows);
    expect(first.rows.filter((row) => row.readability === 'concealed')).toHaveLength(1);
    const gets = fixture.calls.filter((call) => call.method === 'GET');
    expect(gets).toHaveLength(3);
    firstPages.push(first.rows.length);
    firstBytes.push(first.visit.components.find((item) => item.id === 'association')!.bytes);
    const deep = await fixture.read(`forward:${basedOnProperty}`, String(scale - RELEASE_ASSOCIATION_LIMIT));
    if (!deep.ok) throw new Error(`Expected deep page at ${scale}`);
    expect(deep.rows.length).toBeLessThanOrEqual(RELEASE_ASSOCIATION_LIMIT);
    expect(deep.visit.calls).toBe(3);
    const selected = await fixture.read(`forward:${basedOnProperty}`, undefined, releaseAlt);
    if (!selected.ok) throw new Error(`Expected replaced selection at ${scale}`);
    expect(selected.detail?.subject.id).toBe(releaseAlt);
    expect(selected.visit.components.find((item) => item.id === 'detail')?.calls).toBe(1);
    expect(fixture.calls.filter((call) => call.path === `/v1/subjects/${releaseAlt}`)).toHaveLength(1);
  }
  expect(new Set(firstPages)).toEqual(new Set([RELEASE_ASSOCIATION_LIMIT]));
  expect(Math.max(...firstBytes) / Math.min(...firstBytes)).toBeLessThan(2);
});

test('frame entry and eight locales keep interpolation for unknown source codes', () => {
  const html = renderToStaticMarkup(
    createElement(ReleaseFidelityEntry, {
      id: releaseSubject,
      type: 'bf:Instance',
      label: 'Japanese paperback',
      locale: 'en',
    }),
  );
  expect(html).toContain('/release');
  expect(html).toContain(m.release_fidelity_title({}, { locale: 'en' }));
  expect(catalogueEntries.releaseFidelity({ id: releaseSubject, type: 'schema:Book', locale: 'en' })).toBeUndefined();
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const)
    expect(m.release_fidelity_related_unknown({ code: 'anidb:rel:9999' }, { locale })).toContain('anidb:rel:9999');
});
