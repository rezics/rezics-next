import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RelationRows } from '../features/work-levels/connections.tsx';
import * as fixture from '../features/work-levels/fixtures.ts';
import { copyOf, englishMessages, messages } from '../features/work-levels/messages.ts';
import { labelFor, relationRows } from '../features/work-levels/relation-rows.ts';
import { connectionsHref, editionsHref, parseConnectionsQuery, parseEditionsQuery, parseIsbn, parseReleaseId,
  releaseHref } from '../features/work-levels/route.ts';
import type { RelationEntry } from '../features/work-levels/types.ts';
import { uiLocales } from '../i18n/define.ts';

const uuid = '01944100-0000-7000-8000-000000000123';

describe('G-837 page addresses', () => {
  test('the Connections query keeps grain, group and cursors, and refuses what is malformed', () => {
    expect(parseConnectionsQuery({})).toEqual({ grain: 'series', parent: undefined, partsAfter: undefined,
      relationsAfter: undefined, franchise: undefined, membersAfter: undefined });
    expect(parseConnectionsQuery({ grain: 'parts', parent: uuid, partsAfter: 'abc' })).toMatchObject({ grain: 'parts', parent: uuid,
      partsAfter: 'abc' });
    for (const bad of [{ grain: 'volumes' }, { parent: 'not-a-uuid' }, { franchise: 'x' }, { grain: ['series', 'parts'] },
      { partsAfter: 'x'.repeat(2049) }]) expect(parseConnectionsQuery(bad)).toBeNull();
  });

  test('the Editions query accepts cursors only', () => {
    expect(parseEditionsQuery({ releasesAfter: 'r' })).toEqual({ realizationsAfter: undefined, releasesAfter: 'r' });
    expect(parseEditionsQuery({ releasesAfter: ['a', 'b'] })).toBeNull();
  });

  test('links carry stable anchors and leave defaults out', () => {
    expect(connectionsHref('sao', {}, 'parts')).toBe('/w/sao/connections#parts');
    expect(connectionsHref('sao', { grain: 'series' })).toBe('/w/sao/connections');
    expect(connectionsHref('sao', { grain: 'parts', partsAfter: 'c' }, 'parts')).toBe('/w/sao/connections?grain=parts&partsAfter=c#parts');
    expect(editionsHref('sao', { releasesAfter: 'r' }, 'releases')).toBe('/w/sao/editions?releasesAfter=r#releases');
    expect(releaseHref(`https://rezics.com/id/${uuid}`)).toBe(`/releases/${uuid}`);
  });

  test('a release segment is a UUID in any case', () => {
    expect(parseReleaseId(uuid.toUpperCase())).toBe(uuid);
    expect(parseReleaseId('9780316371247')).toBeNull();
  });

  test('an ISBN segment is an ISBN-13, an ISBN-10 spelled as one, or nothing Main is asked about', () => {
    expect(parseIsbn('9780316371247')).toBe('9780316371247');
    expect(parseIsbn('978-0-316-37124-7')).toBe('9780316371247');
    expect(parseIsbn('978%200316371247')).toBe('9780316371247');
    expect(parseIsbn('0316371246')).toBe('9780316371247');
    expect(parseIsbn('0-8044-2957-X')).toBe('9780804429573');
    expect(parseIsbn('9780316371248')).toBeNull();
    expect(parseIsbn('0316371247')).toBeNull();
    expect(parseIsbn('12345')).toBeNull();
    expect(parseIsbn('%E0%A4%A')).toBeNull();
  });
});

const rendering = (entry: RelationEntry) => entry.rendering!;

describe('G-837 relation rows come from Main’s rendering', () => {
  const rows = relationRows(fixture.relationEntries);

  test('franchise entries are not relations; each direction gets a row under the label Main selected', () => {
    expect(rows.map(row => row.label.text?.value)).toEqual(['Reboot of', 'Spin-offs', '続編元']);
    expect(rows.every(row => row.style === 'row')).toBe(true);
    expect(rows[1]!.items.map(item => item.target.kind === 'resource' && item.target.reference))
      .toEqual([fixture.iri('301'), fixture.iri('302')]);
  });

  test('an unresolved source is carried by the row and a fallback label names the language it is in', () => {
    expect(rows[0]!.items[0]!.unresolvedSource).toBe(true);
    expect(rows[1]!.items[0]!.unresolvedSource).toBe(false);
    expect(rows[2]!.label.fallbackLanguage).toBe('ja');
    expect(rows[0]!.label.fallbackLanguage).toBeNull();
  });

  test('the label takes the plural form Main supplies for the count', () => {
    const projection = rendering(fixture.relationEntries[2]!).projections[0]!;
    expect(labelFor(projection, 1).text?.value).toBe('Spin-off');
    expect(labelFor(projection, 2).text?.value).toBe('Spin-offs');
    expect(labelFor({ ...projection, labels: null }, 1).text).toBeNull();
  });

  test('relations to people or characters read as role chips, and withheld or external counterparts stay visible', () => {
    const entry = structuredClone(fixture.relationEntries[2]!);
    entry.counterparts = [fixture.summary(fixture.iri('a1'), 'Reki Kawahara', 'ja', 'resource')];
    const projection = rendering(entry).projections[0]!;
    projection.arguments = [{ role: 'spin-off', type: 'resource', value: { kind: 'resource', ref: fixture.iri('a1') } },
      { role: 'spin-off', type: 'external', value: { kind: 'external', key: 'OL123A' } },
      { role: 'spin-off', type: 'unavailable-reference', value: { kind: 'unavailable-reference' } }];
    const [chips] = relationRows([entry]);
    expect(chips!.style).toBe('chips');
    expect(chips!.items.map(item => item.target.kind)).toEqual(['resource', 'external', 'withheld']);
    // Each chip names one counterpart, so each takes the singular label, not the row's plural.
    const markup = renderToStaticMarkup(createElement(RelationRows, { rows: [chips!], locale: 'en', t: copyOf('en') }));
    expect([...markup.matchAll(/data-role-chip/g)]).toHaveLength(3);
    expect([...markup.matchAll(/Spin-off</g)]).toHaveLength(3);
    expect(markup).not.toContain('Spin-offs');
  });
});

describe('G-837 class guard: no relation row is built on the client', () => {
  // A label no client table could know: if a row shows it, it came from Main's rendering.
  const invented = structuredClone(fixture.relationEntries[1]!);
  rendering(invented).projections[0]!.labels = { noun: 'Zorblax of', heading: 'Zorblaxes of',
    plurals: { one: 'Zorblax of', other: 'Zorblaxes of' }, grammaticalForms: [] };
  const html = (locale: 'en' | 'ja', entries: RelationEntry[]) => renderToStaticMarkup(createElement(RelationRows,
    { rows: relationRows(entries), locale, t: copyOf(locale) }));

  test('a row shows exactly Main’s label and the counterpart’s own name, nothing around them', () => {
    const markup = html('en', [invented]);
    expect(markup).toContain('Zorblax of');
    expect(markup).toContain('とある魔術の禁書目録');
    expect(markup).not.toMatch(/Zorblax of\s+of/);
    // The name's language and direction travel with it, isolated from the row.
    expect(markup).toMatch(/<bdi lang="ja" dir="ltr">とある魔術の禁書目録<\/bdi>/);
  });

  test('an inverse direction adds no "of" and a missing label is the neutral word, never a guess from the kind', () => {
    const missing = structuredClone(invented);
    rendering(missing).projections[0]!.labels = null;
    const markup = html('ja', [missing]);
    expect(markup).toContain(copyOf('ja').relatedFallback);
    expect(markup).not.toMatch(/Reboot|Sequel|Adaptation/i);
  });

  test('the feature names no relation kind and its catalogs hold no relation wording', () => {
    const directory = join(import.meta.dir, '../features/work-levels');
    const sources = readdirSync(directory).filter(name => /\.tsx?$/.test(name)
      && !/(fixtures|\.stories)\./.test(name) && name !== 'messages.ts');
    const kinds = /\b(reboot|spin-?off|sequel|prequel|adaptation|rewrite|remake|derivation kind)s?\b/i;
    for (const name of sources) {
      const code = readFileSync(join(directory, name), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
      expect(code, name).not.toMatch(kinds);
      expect(code, name).not.toMatch(/['"`]\s*of\s*['"`]|\+\s*['"`] of/);
    }
    for (const locale of uiLocales) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(`${key} ${typeof value === 'string' ? value : ''}`, `${locale}.${key}`).not.toMatch(kinds);
      }
    }
  });
});

describe('G-837 catalogs', () => {
  test('every locale supplies every key and keeps its placeholders', () => {
    for (const locale of uiLocales) {
      expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(englishMessages).sort());
    }
    expect(copyOf('de').coversWorks(3)).toBe('Enthält 3 Werke');
    expect(copyOf('zh-Hans').coversWorks(1)).toBe('涵盖 1 部作品');
    expect(copyOf('fr').labelIn({ language: 'japonais' })).toBe('en japonais');
  });
});
