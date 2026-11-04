import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { readListPresentationFacts } from '../../src/semantic/list-presentation.ts';
import type { CurrentWorkContext, WorkContextSection } from '../../src/search/work-context.ts';
import { citedValue, createListPresentationFixture } from './support/list-presentation-fixture.ts';

const date = (time: string, precision: number) => ({
  time,
  precision,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
function entries(section: WorkContextSection) {
  expect(section.state).toBe('current');
  if (section.state !== 'current') throw new Error('Expected current qualified entries');
  return section.items;
}

test('native same-title works retain exact credits, directed releases, partial dates and honest reductions', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const first = await f.create('schema:Person', {}, { en: 'Same creator' });
    const second = await f.create('schema:Person', {}, { en: 'Same creator' });
    const role = await f.create('skos:Concept', {}, { en: 'Detailed native role' });
    const credit = (id: string, name: string) => ({
      ...citedValue('schema:author', id),
      qualifiers: [citedValue('wdt:P1932', name, false), citedValue('wdt:P3831', role, false)],
    });
    const work = await f.create(
      'schema:Book',
      { 'schema:datePublished': date('+2020-00-00T00:00:00Z', 9) },
      { en: 'Shared title' },
      { 'schema:author': [credit(first, 'First credit'), credit(second, 'Second credit')] },
    );
    const other = await f.create('schema:Book', { 'schema:contributor': second }, { en: 'Shared title' });
    const release = await f.create(
      'bf:Instance',
      {
        'schema:exampleOfWork': work,
        'schema:datePublished': date('+2021-03-00T00:00:00Z', 10),
      },
      { en: 'Shared title' },
    );
    const album = await f.create('schema:MusicAlbum', { 'schema:contributor': first }, { en: 'Shared title' });
    const empty = await f.create('schema:Book');
    const unknown = await f.create(
      'schema:Book',
      {},
      { en: 'Unknown date' },
      {
        'schema:datePublished': [{ ...citedValue('schema:datePublished', ''), value: { type: 'somevalue' } }],
        'schema:author': [{ ...citedValue('schema:author', ''), value: { type: 'somevalue' } }],
      },
    );
    const none = await f.create(
      'schema:Book',
      {},
      { en: 'No date' },
      {
        'schema:datePublished': [{ ...citedValue('schema:datePublished', ''), value: { type: 'novalue' } }],
        'schema:contributor': [{ ...citedValue('schema:contributor', ''), value: { type: 'novalue' } }],
      },
    );
    const read = async (ids: string[]) =>
      readListPresentationFacts(await f.deps(), ids, { languages: ['en'], workContext: true });
    const all = await read([work, other, release, album, empty, unknown, none, first]);
    const context = all.get(work)!.workContext as CurrentWorkContext;
    const credits = entries(context.creators);
    expect(new Set(credits.map((entry) => entry.statementId)).size).toBe(2);
    expect(credits.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first, labels: { en: 'Same creator' } }),
        expect.objectContaining({ id: second, labels: { en: 'Same creator' } }),
      ]),
    );
    for (const entry of credits) {
      expect(entry.sourceId).toBe(work);
      expect(entry.property.id).toBe('schema:author');
      expect(entry.qualifiers).toMatchObject({
        state: 'current',
        items: [
          {
            property: { id: 'wdt:P1932' },
            value: {
              text:
                entry.value.state === 'value' && entry.value.kind === 'item' && entry.value.id === first
                  ? 'First credit'
                  : 'Second credit',
            },
          },
          { property: { id: 'wdt:P3831' }, value: { id: role, labels: { en: 'Detailed native role' } } },
        ],
      });
    }
    expect(entries(context.dates)[0]!.value).toEqual({
      state: 'value',
      kind: 'time',
      calendar: 'gregorian',
      year: 2020,
    });
    expect(context.relations).toEqual({ state: 'empty' }); // no invented work -> edition inverse
    const edition = all.get(release)!.workContext as CurrentWorkContext;
    expect(edition.kind).toBe('release');
    expect(entries(edition.relations)[0]).toMatchObject({
      direction: 'outgoing',
      sourceId: release,
      property: { id: 'schema:exampleOfWork' },
      value: { id: work, type: { id: 'schema:Book' } },
    });
    expect(entries(edition.dates)[0]!.value).toEqual({
      state: 'value',
      kind: 'time',
      calendar: 'gregorian',
      year: 2021,
      month: 3,
    });
    expect(entries((all.get(other)!.workContext as CurrentWorkContext).creators)[0]!.property.id).toBe(
      'schema:contributor',
    );
    expect((all.get(album)!.workContext as CurrentWorkContext).kind).toBe('work');
    expect((all.get(empty)!.workContext as CurrentWorkContext).creators).toEqual({ state: 'empty' });
    expect(entries((all.get(unknown)!.workContext as CurrentWorkContext).dates)[0]!.value).toEqual({
      state: 'somevalue',
    });
    expect(entries((all.get(none)!.workContext as CurrentWorkContext).dates)[0]!.value).toEqual({ state: 'novalue' });
    expect(entries((all.get(unknown)!.workContext as CurrentWorkContext).creators)[0]!.value).toEqual({
      state: 'somevalue',
    });
    expect(entries((all.get(none)!.workContext as CurrentWorkContext).creators)[0]!.value).toEqual({
      state: 'novalue',
    });
    expect(all.get(first)!.workContext).toBeUndefined();
    await f.hide(role);
    const concealed = (await read([work])).get(work)!.workContext as CurrentWorkContext;
    expect(concealed.creators).toEqual({ state: 'withheld' });
    expect(JSON.stringify(concealed)).not.toContain(role);
    expect(JSON.stringify(concealed)).not.toContain(first);
    expect(entries(concealed.dates)).toHaveLength(1);
    expect(f.maximumHeldBackends()).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180000);

test('native disclosed lookahead, exact source fences and changed identity retire qualified context', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const creators: string[] = [];
    for (let i = 0; i < 4; i++) creators.push(await f.create('schema:Person', {}, { en: `Creator ${i}` }));
    const work = await f.create('schema:Book', { 'schema:author': creators });
    const read = async (ids: string[]) =>
      readListPresentationFacts(await f.deps(), ids, { languages: ['en'], workContext: true });
    const context = (await read([work])).get(work)!.workContext as CurrentWorkContext;
    expect(context.creators).toMatchObject({ state: 'current', overflow: true });
    expect(entries(context.creators)).toHaveLength(3);
    expect(context.creators).not.toHaveProperty('more');
    const imported = await f.imported('schema:datePublished', date('+2022-00-00T00:00:00Z', 9));
    expect(
      entries(((await read([imported.id])).get(imported.id)!.workContext as CurrentWorkContext).dates),
    ).toHaveLength(1);
    await f.checked('POST', '/v1/sourceFences:takedown', {
      source: imported.source.source,
      externalId: imported.source.external_id,
      fieldGroup: 'facts',
      reason: 'Exact source removed',
    });
    expect(((await read([imported.id])).get(imported.id)!.workContext as CurrentWorkContext).dates).toEqual({
      state: 'withheld',
    });
    const deps = await f.deps();
    let reads = 0;
    const access = deriveAccess(deps.access, {
      async prepare(actor, action, resource, options) {
        if (resource.id === work && ++reads === 2) await f.hide(work);
        return deps.access.prepare!(actor, action, resource, options);
      },
    });
    await expect(readListPresentationFacts({ ...deps, access }, [work], { workContext: true })).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
    expect(bundledRelease.types['schema:MusicRelease']).toBeUndefined();
    expect(bundledRelease.types['schema:MusicRecording']).toBeUndefined();
  } finally {
    await f.close();
  }
}, 180000);
