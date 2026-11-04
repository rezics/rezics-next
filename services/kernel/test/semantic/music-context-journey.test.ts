import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest, type Release } from '@rezics/definitions';
import { createSemanticDriver } from './outcome-driver.ts';

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const MUSIC_TYPES = [
  'schema:Place',
  'schema:MusicVenue',
  'schema:AdministrativeArea',
  'schema:Event',
  'schema:MusicEvent',
  'wd:Q34379',
] as const;
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const date = (time: string, precision: 9 | 10 | 11) => ({ time, precision, calendarmodel: GREGORIAN });
const cited = (property: string, content: unknown, qualifiers: Record<string, unknown>[] = []) => ({
  property: { id: property },
  value: { type: 'value' as const, content },
  rank: 'normal' as const,
  qualifiers,
  references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/src' } }] }],
});

function closedRelease(): Release {
  const release = structuredClone(bundledRelease);
  for (const id of MUSIC_TYPES) delete release.types[id];
  for (const term of ['schema:location', 'schema:containedInPlace', 'wdt:P1303'] as const) delete release.properties[term];
  release.catalogue = { ...release.catalogue, version: '1.0.1-music-context-closed' };
  return release;
}

test('a reader follows a sourced music event through native review and a bounded production page', async () => {
  const driver = await createSemanticDriver(undefined, { strictCleanup: true, originalCapabilities: true });
  try {
    const outsider = await driver.fixtures.person('outsider');
    await driver.grant('steward', ['moderation:hide'], driver.globalContext);
    const create = async (type: string, label: string) => {
      const created = await driver.request('editor', 'POST', '/v1/subjects', { type, labels: { en: label } }, key());
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.subject as { id: string; type: string };
    };
    const adopt = async (id: string, statement: ReturnType<typeof cited>) => {
      const path = `/v1/subjects/${id}`;
      const proposed = await driver.request('editor', 'POST', `${path}/candidates`, { statement }, key());
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      const candidate = proposed.body.candidate as string;
      const listing = await driver.request(
        'acceptor',
        'GET',
        `${path}/candidates?property=${encodeURIComponent(statement.property.id)}`,
      );
      const pending = (listing.body.candidates as { id: string; head: number | null }[]).find(
        (row) => row.id === candidate,
      );
      expect(pending).toBeDefined();
      const accepted = await driver.request(
        'acceptor',
        'POST',
        `${path}/candidates/${candidate}:accept`,
        { context: driver.globalContext, expected_head: pending!.head },
        key(),
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await driver.request(
        'acceptor',
        'POST',
        `${path}:adopt`,
        {
          context: driver.globalContext,
          property: statement.property.id,
          mode: 'replace',
          selection: [{ candidate, rank: 'normal' }],
          expected_head: (listing.body.adoption as { head: number } | null)?.head ?? null,
        },
        key(),
      );
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
      return candidate;
    };
    const actions = async (persona: 'anonymous' | 'editor' | 'suspended', id: string, type: string) => {
      const response = await driver.request(persona, 'POST', '/v1/viewerActions', { resources: [{ type, id }] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return (response.body.resources as { viewerActions?: { action: string }[] }[])[0]!.viewerActions ?? [];
    };

    const area = await create('schema:AdministrativeArea', 'Osaka');
    const venue = await create('schema:MusicVenue', 'Festival Hall');
    const piano = await create('wd:Q34379', 'Piano');
    const event = await create('schema:MusicEvent', 'Spring concert');
    const album = await create('schema:MusicAlbum', 'Live recording');
    await adopt(venue.id, cited('schema:containedInPlace', area.id));
    const location = await adopt(event.id, cited('schema:location', venue.id));
    await adopt(event.id, cited('schema:startDate', date('+2024-05-00T00:00:00Z', 10)));
    await adopt(event.id, cited('schema:endDate', date('+2024-00-00T00:00:00Z', 9)));
    await adopt(
      event.id,
      cited('wdt:P1303', piano.id, [{ property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'piano' } }]),
    );

    const crossed = await driver.request(
      'editor',
      'POST',
      `/v1/subjects/${event.id}/candidates`,
      { statement: cited('schema:location', album.id) },
      key(),
    );
    expect(crossed.status).toBe(400);
    expect(crossed.body.errors).toContainEqual({ pointer: '/statement/value/content', code: 'out_of_range' });

    const page = await driver.request('anonymous', 'POST', '/v1/pages:read', { target: { subject: event.id } });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.body.subject).toBe(event.id);
    const subjectRead = Object.values(page.body.reads as Record<string, { status: number; body: Record<string, any> }>).find(
      (read) => read.status === 200 && read.body.subject?.id === event.id,
    );
    expect(subjectRead?.body.subject.statements['schema:location'][0].value.content).toBe(venue.id);
    expect(subjectRead?.body.subject.statements['schema:startDate'][0].value.content.precision).toBe(10);
    expect(subjectRead?.body.subject.statements['wdt:P1303'][0].qualifiers[0].value.content).toBe('piano');

    const editorPage = await driver.request('editor', 'POST', '/v1/pages:read', { target: { subject: event.id } });
    expect(editorPage.status).toBe(200);
    const publicFacts = (body: Record<string, any>) =>
      Object.values(body.reads as Record<string, { body: Record<string, unknown> }>).map((read) => read.body);
    expect(publicFacts(editorPage.body)).toEqual(publicFacts(page.body));

    const editorActions = await actions('editor', event.id, event.type);
    const readerActions = await actions('anonymous', event.id, event.type);
    const suspendedActions = await actions('suspended', event.id, event.type);
    expect(editorActions.map((entry) => entry.action)).toEqual(expect.arrayContaining(['statement:propose', 'subject:read']));
    expect(readerActions.map((entry) => entry.action)).toContain('subject:read');
    expect(readerActions.map((entry) => entry.action)).not.toContain('statement:propose');
    expect(suspendedActions.map((entry) => entry.action)).not.toContain('statement:propose');
    const outsiderActions = await driver.fixtures.send(outsider, 'POST', '/v1/viewerActions', {
      resources: [{ type: event.type, id: event.id }],
    });
    expect(outsiderActions.status).toBe(200);
    expect(
      (outsiderActions.body.resources as { viewerActions?: { action: string }[] }[])[0]!.viewerActions?.map(
        (entry) => entry.action,
      ),
    ).not.toContain('statement:propose');

    const hidden = await driver.request(
      'steward',
      'POST',
      `/v1/subjects/${event.id}/candidates/${location}:hide`,
      { reason: 'spam' },
      key(),
    );
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    const concealed = await driver.request('anonymous', 'GET', `/v1/subjects/${event.id}`);
    expect(concealed.status).toBe(200);
    const concealedSubject = concealed.body.subject as {
      statements: Record<string, unknown[]>;
      type: string;
      release: string;
    };
    expect(concealedSubject.statements['schema:location'] ?? []).toEqual([]);
    expect(concealedSubject.statements['schema:startDate']).toHaveLength(1);
    expect(concealedSubject.statements['wdt:P1303']).toHaveLength(1);

    const published = await driver.request('steward', 'POST', '/v1/definitions/releases', { release: closedRelease() }, key());
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const publishedDigest = published.body.digest as string;
    const old = await driver.request('anonymous', 'GET', `/v1/definitions/releases/${publishedDigest}`);
    expect(old.status).toBe(200);
    const oldRelease = old.body.release as Release;
    expect(old.body.digest as string).not.toBe(bundledDigest);
    expect(oldRelease.types['schema:MusicEvent']).toBeUndefined();
    expect(oldRelease.types['schema:Book']).toBeDefined();
    const current = await driver.request('anonymous', 'GET', '/v1/definitions/active');
    expect(current.body.digest as string).toBe(bundledDigest);
    expect(releaseDigest(oldRelease)).toBe(publishedDigest);
    const still = await driver.request('anonymous', 'GET', `/v1/subjects/${event.id}`);
    expect(still.status).toBe(200);
    const stillSubject = still.body.subject as { type: string; release: string };
    expect(stillSubject.type).toBe('schema:MusicEvent');
    expect(stillSubject.release).toBe(bundledDigest);
  } finally {
    await driver.close();
  }
}, 180_000);
