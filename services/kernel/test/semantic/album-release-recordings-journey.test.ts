import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import { selectLibraryProfile } from '../../src/library/profile.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { HttpResponse, StatementInput, Subject } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const SECONDS = 'http://www.wikidata.org/entity/Q11574';
const pins = {
  '1.0.0': 'sha256:5ce80804c4cc09983190130049f7883ebdb2f628cd30db0f774d5889d23fa0bd',
  '1.0.1': 'sha256:2d984ead9d128012123bed3f34481f703df84070edcd139f3615441e61ff1de7',
};
let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
}, 180_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function ok(response: HttpResponse, status = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response.body;
}
function subject(response: HttpResponse): Subject {
  return ok(response).subject as Subject;
}
function facts(value: Subject, property: string) {
  return value.statements[property] ?? [];
}
type Proposed = Omit<StatementInput, 'value'> & {
  value: StatementInput['value'] | { type: 'somevalue' } | { type: 'novalue' };
};
function problem(response: HttpResponse, status: number, code: string) {
  ok(response, status);
  expect(response.body.code).toBe(code);
}
const snak = (property: string, content: StatementInput['value']['content']) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
});
const date = (time: string, precision: 9 | 10 | 11) => ({ time, precision, calendarmodel: GREGORIAN });

async function adopted(holder: CreatedSubject, input: Proposed, key?: string) {
  if (!key) {
    const receipt = await fixture.adopt(holder, input);
    expect(receipt.release).toBe(bundledDigest);
    return receipt;
  }
  const proposed = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${holder.id}/candidates`,
    { statement: input },
    discoveryKey(),
  );
  ok(proposed, 201);
  const candidate = proposed.body.candidate as string;
  ok(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}/candidates/${candidate}:accept`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      discoveryKey(),
    ),
  );
  const target =
    input.value.type === 'value' && typeof input.value.content === 'string' ? input.value.content : undefined;
  ok(
    await fixture.request(
      'acceptor',
      'POST',
      `/v1/subjects/${holder.id}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: input.property.id,
        ...(target ? { target } : {}),
        key,
        mode: 'replace',
        selection: [{ candidate, rank: input.rank ?? 'normal' }],
        expected_head: null,
      },
      discoveryKey(),
    ),
  );
  return { candidate, subject: holder.id, property: input.property.id, release: bundledDigest };
}

test('a reader follows an album through two released editions and ordered recordings with native access', async () => {
  const definition = fixture.release.definition;
  expect(fixture.release.digest).toBe(bundledDigest);
  expect(releaseDigest(definition)).toBe(bundledDigest);
  expect(bundledDigest).not.toBe(pins['1.0.0']);
  expect(bundledDigest).not.toBe(pins['1.0.1']);
  for (const type of ['schema:MusicRelease', 'schema:MusicRecording'] as const) {
    const descriptor = definition.types[type]!;
    expect(descriptor.library).toBeUndefined();
    expect(selectLibraryProfile(definition, type)).toBeNull();
    for (const locale of locales) {
      expect(descriptor.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(descriptor.descriptions?.[locale]?.trim().length).toBeGreaterThan(10);
    }
  }
  expect(definition.types['schema:MusicAlbum']!.library).toBeUndefined();
  expect(definition.types['rezics:MusicMedium']).toBeUndefined();
  expect(definition.properties['schema:track']!.relation).toMatchObject({
    inverse: 'rezics:recordingOn',
    slotKey: 'wdt:P642',
    order: 'position',
  });
  expect(definition.properties['schema:releaseOf']!.relation?.inverse).toBe('schema:albumRelease');
  expect(definition.types['schema:MusicAlbum']!.properties).toContain('wdt:P5732');
  expect(definition.types['schema:MusicRelease']!.properties).not.toContain('wdt:P5732');
  expect(definition.types['schema:Movie']!.library?.profileId).toBe('anime.film');
  expect(definition.types['schema:TVSeries']!.library?.profileId).toBe('anime.series');

  const album = await fixture.createSubject('schema:MusicAlbum', 'Harbour sessions');
  const cd = await fixture.createSubject('schema:MusicRelease', 'Harbour sessions Japan CD');
  const vinyl = await fixture.createSubject('schema:MusicRelease', 'Harbour sessions vinyl');
  const recording = await fixture.createSubject('schema:MusicRecording', 'Harbour');
  const copy = await fixture.createSubject('schema:MusicAlbum', 'Personal harbour copy');
  const label = await fixture.createSubject('schema:Organization', 'Harbour records');
  const format = await fixture.createSubject('skos:Concept', 'Compact disc');
  const vinylFormat = await fixture.createSubject('skos:Concept', 'Vinyl disc');
  const firstSlot = await fixture.createSubject('skos:Concept', 'Listing occurrence 1');
  const encoreSlot = await fixture.createSubject('skos:Concept', 'Listing occurrence encore');
  const artist = await fixture.createSubject('schema:Person', 'Harbour ensemble');
  const role = await fixture.createSubject('skos:Concept', 'Performer');

  await adopted(cd, discoveryStatement('schema:releaseOf', album.id));
  await adopted(vinyl, discoveryStatement('schema:releaseOf', album.id));
  await adopted(cd, discoveryStatement('schema:catalogNumber', 'HBR-CD-01'));
  await adopted(cd, discoveryStatement('wdt:P437', format.id));
  await adopted(vinyl, discoveryStatement('wdt:P437', vinylFormat.id));
  await adopted(cd, discoveryStatement('schema:recordLabel', label.id));
  await adopted(cd, discoveryStatement('schema:duration', { amount: '+2400', unit: SECONDS }));
  await adopted(cd, {
    ...discoveryStatement('schema:datePublished', date('+2024-05-02T00:00:00Z', 11)),
  });
  await adopted(vinyl, {
    ...discoveryStatement('schema:datePublished', date('+2024-00-00T00:00:00Z', 9)),
  });
  const tba = await fixture.createSubject('schema:MusicRelease', 'Harbour sessions TBA edition');
  await adopted(tba, discoveryStatement('schema:releaseOf', album.id));
  await adopted(tba, { ...discoveryStatement('schema:datePublished', 'pending'), value: { type: 'somevalue' } });
  const none = await fixture.createSubject('schema:MusicRelease', 'Harbour sessions undated edition');
  await adopted(none, discoveryStatement('schema:releaseOf', album.id));
  await adopted(none, { ...discoveryStatement('schema:datePublished', 'none'), value: { type: 'novalue' } });

  const track = (target: string, position: string, occurrence: string, creditedAs: string): StatementInput => ({
    ...discoveryStatement('schema:track', target),
    qualifiers: [
      snak('schema:position', position),
      snak('wdt:P1932', creditedAs),
      snak('wdt:P3831', role.id),
      snak('schema:datePublished', date('+2024-05-02T00:00:00Z', 11)),
      snak('wdt:P642', occurrence),
    ],
  });
  await adopted(cd, track(recording.id, '1', firstSlot.id, 'Harbour'), firstSlot.id);
  await adopted(cd, track(recording.id, '3', encoreSlot.id, 'Harbour reprise'), encoreSlot.id);
  await adopted(recording, discoveryStatement('schema:byArtist', artist.id));
  await adopted(recording, discoveryStatement('schema:duration', { amount: '+180', unit: SECONDS }));

  const wrong = await fixture.request(
    'editor',
    'POST',
    `/v1/subjects/${cd.id}/candidates`,
    { statement: discoveryStatement('schema:track', album.id) },
    discoveryKey(),
  );
  expect([400, 422]).toContain(wrong.status);
  expect(wrong.body.effect_status ?? 'not_applied').not.toBe('applied');

  await fixture.catchUp([
    album,
    cd,
    vinyl,
    recording,
    copy,
    label,
    format,
    vinylFormat,
    firstSlot,
    encoreSlot,
    artist,
    role,
    tba,
    none,
  ]);
  const editions = ok(
    await fixture.request('anonymous', 'GET', `/v1/subjects/${album.id}/links?property=schema%3AreleaseOf&limit=20`),
  );
  expect((editions.links as { subject: string }[]).map((row) => row.subject).sort()).toEqual(
    [cd.id, vinyl.id, tba.id, none.id].sort(),
  );
  expect(editions.next).toBeNull();
  const tracks = ok(
    await fixture.request('anonymous', 'GET', `/v1/subjects/${cd.id}/relations?property=schema%3Atrack&limit=20`),
  );
  const rows = tracks.relations as {
    target: string;
    statement: { id: string; qualifiers: { property: { id: string }; value: { content: string } }[] };
  }[];
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.target)).toEqual([recording.id, recording.id]);
  expect(new Set(rows.map((row) => row.statement.id)).size).toBe(2);
  expect(
    rows.map(
      (row) => row.statement.qualifiers.find((qualifier) => qualifier.property.id === 'schema:position')?.value.content,
    ),
  ).toEqual(['1', '3']);
  expect(facts(subject(await fixture.read(copy)), 'schema:releaseOf')).toEqual([]);
  expect(facts(subject(await fixture.read(cd)), 'schema:releaseOf')[0]?.value.content).toBe(album.id);
  expect(facts(subject(await fixture.read(cd)), 'schema:datePublished')[0]?.rezics.release).toBe(bundledDigest);
  expect(facts(subject(await fixture.read(tba)), 'schema:datePublished')[0]?.value as unknown).toEqual({
    type: 'somevalue',
  });
  expect(facts(subject(await fixture.read(none)), 'schema:datePublished')[0]?.value as unknown).toEqual({
    type: 'novalue',
  });
  expect(facts(subject(await fixture.read(vinyl)), 'schema:datePublished')[0]?.value.content).toMatchObject({
    precision: 9,
  });
  expect(facts(subject(await fixture.read(album)), 'schema:datePublished')).toEqual([]);

  for (const persona of ['anonymous', 'outsider', 'bob'] as const) {
    const read = subject(await fixture.read(cd, persona));
    expect(read.type).toBe('schema:MusicRelease');
    expect(facts(read, 'schema:catalogNumber')[0]?.value.content).toBe('HBR-CD-01');
    expect(facts(read, 'schema:track')).toHaveLength(2);
  }
  const before = subject(await fixture.read(cd));
  const denied = await fixture.request(
    'outsider',
    'POST',
    `/v1/subjects/${cd.id}:adopt`,
    {
      context: GLOBAL_CONTEXT,
      property: 'schema:catalogNumber',
      mode: 'replace',
      selection: [],
      expected_head: null,
    },
    discoveryKey(),
  );
  problem(denied, 403, 'forbidden');
  expect(subject(await fixture.read(cd))).toEqual(before);

  const page = ok(await fixture.request('anonymous', 'POST', '/v1/pages:read', { target: { subject: cd.id } }));
  expect(page.subject).toBe(cd.id);
  expect(page.catalogue).toMatchObject({ state: 'released', type: 'schema:MusicRelease', digest: bundledDigest });
  expect(page.viewer).toMatchObject({
    state: 'anonymous',
    actions: { statementPropose: 'denied' },
  });
  const actionStatus = (page as { actions?: { status: string } }).actions?.status ?? 'missing';
  expect(['ready', 'withheld', 'unavailable', 'denied']).toContain(actionStatus);
  expect(Object.keys(page.reads as object).length).toBeLessThanOrEqual(16);
  const editorPage = ok(await fixture.request('editor', 'POST', '/v1/pages:read', { target: { subject: cd.id } }));
  expect(editorPage.viewer).toMatchObject({
    state: 'account',
    actions: { statementPropose: expect.stringMatching(/^(allowed|denied|unavailable)$/) },
  });
  const { viewer: _v, actions: _a, ...publicAnonymous } = page;
  const { viewer: _ev, actions: _ea, ...publicEditor } = editorPage;
  expect(publicEditor).toEqual(publicAnonymous);

  await fixture.grant('editor', ['moderation:hide'], GLOBAL_CONTEXT);
  ok(
    await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${recording.id}:hide`,
      { reason: 'Hidden recording identity' },
      discoveryKey(),
    ),
  );
  expect((await fixture.read(recording, 'anonymous')).status).toBe(404);
  const hiddenPage = await fixture.request('anonymous', 'POST', '/v1/pages:read', {
    target: { subject: recording.id },
  });
  expect(hiddenPage.status).toBe(404);
  const remaining = ok(
    await fixture.request('anonymous', 'GET', `/v1/subjects/${cd.id}/relations?property=schema%3Atrack&limit=20`),
  );
  expect((remaining.relations as unknown[]).length).toBe(2);
}, 180_000);
