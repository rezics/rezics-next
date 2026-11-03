import { expect, test } from 'bun:test';
import {
  createPublication,
  publicationDraft,
  publicationProfiles,
  readPublicationEditor,
  type PublicationCommand,
  type PublicationRead,
} from '../src/features/catalogue/publication-editor';
import { readCreatedSubject } from '../src/features/catalogue/create-subject-request';
import { publicationCreatedId, publicationFixture } from '../src/kernel/fake/publication-editor';
import type { SessionEnv } from '../src/session/client';

const key = '00000000-0000-4000-8000-00000000e002';
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.invalid',
  API_RESOURCE: 'https://kernel.invalid',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'site',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        accessToken: 'server-only',
        subject: 'viewer',
        csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
      }),
    }),
  },
} as unknown as Partial<SessionEnv>;
const sessionRequest = (csrf = 'AAAAAAAAAAAAAAAAAAAAAA') =>
  new Request('https://site.invalid/api', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.invalid',
      'x-csrf-token': csrf,
    },
  });
const workCitation = 'https://publisher.example/work';
const isbnCitation = 'https://publisher.example/isbn';
function statement(property: string, content: unknown, url = ''): Parameters<typeof publicationDraft>[5][number] {
  return {
    property: { id: property },
    value: { type: 'value', content },
    qualifiers: [],
    references: url ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: url } }] }] : [],
    rank: 'normal',
  };
}
function draft(read: Extract<PublicationRead, { ok: true }>) {
  return publicationDraft(
    read,
    'bf:Instance',
    'schema:exampleOfWork',
    [
      { language: 'en', label: 'A distinct edition', description: 'Paperback notes', aliases: 'Trade\nReprint' },
      { language: 'ja', label: '別版', description: '', aliases: '' },
    ],
    statement('schema:exampleOfWork', read.public.subject.id, workCitation),
    [
      statement('schema:isbn', '978-0-140-44430-8', isbnCitation),
      statement('schema:datePublished', {
        time: '+2026-10-00T00:00:00Z',
        precision: 10,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      }),
      statement('schema:numberOfPages', { amount: '+240', unit: '1' }),
      statement('schema:publisher', '00000000-0000-4000-8000-00000000e003'),
    ],
    true,
  );
}

test('Create an independently identified edition or publication linked to its real work through the declared native contract with truthful authority and failure states', async () => {
  const fixture = publicationFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected real-shaped work read');
  const initial = draft(read);
  expect(initial.errors).toEqual([]);
  const command: PublicationCommand = {
    work: read.public.subject.id,
    relation: 'schema:exampleOfWork',
    item: initial.item,
    key,
  };
  const result = await createPublication(fixture.client, sessionRequest(), sessionEnv, command, 'en');
  expect(result).toEqual({
    ok: true,
    id: publicationCreatedId,
    reader: { state: 'ready', href: `/en/subjects/${publicationCreatedId}/a-distinct-edition` },
  });
  expect(publicationCreatedId).not.toBe(command.work);
  const write = fixture.calls.find((call) => call.method === 'POST')!;
  expect(write).toMatchObject({ path: '/v1/subjects', authorization: 'Bearer server-only', key, body: initial.item });
  expect(initial.item.labels).toEqual({ en: 'A distinct edition', ja: '別版' });
  expect(initial.item.descriptions).toEqual({ en: 'Paperback notes' });
  expect(initial.item.aliases).toEqual({ en: ['Trade', 'Reprint'] });
  expect(initial.item.statements['schema:isbn']![0]!.value).toEqual({ type: 'value', content: '978-0-140-44430-8' });
  expect(initial.item.statements['schema:exampleOfWork']![0]!.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: workCitation } }] },
  ]);
  expect(initial.item.statements['schema:isbn']![0]!.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: isbnCitation } }] },
  ]);
  expect(initial.item.statements['schema:datePublished']![0]!.references).toEqual([]);
  const current = await fixture.client.subjects({ id: publicationCreatedId }).get();
  expect(current.data?.subject.statements['schema:exampleOfWork']?.[0]?.value).toEqual({
    type: 'value',
    content: command.work,
  });
  expect(current.data?.subject.statements['schema:datePublished']?.[0]?.value).toEqual(
    initial.item.statements['schema:datePublished']![0]!.value,
  );
  expect(current.data?.subject.statements['schema:wordCount']).toBeUndefined();
  expect(current.data?.subject.statements['schema:author']).toBeUndefined();
  expect(fixture.calls.find((call) => call.path.endsWith(publicationCreatedId))).toMatchObject({
    method: 'GET',
    authorization: null,
    session: 'publication-session',
  });
  for (const [scenario, reason] of [
    ['denied', 'denied'],
    ['invalid', 'invalid'],
    ['conflict', 'conflict'],
  ] as const) {
    const refusal = publicationFixture(scenario);
    expect(await refusal.transport.submit(command)).toMatchObject({ ok: false, reason });
    expect(refusal.receipts.size).toBe(0);
  }
  const csrf = publicationFixture();
  expect(await createPublication(csrf.client, sessionRequest('wrong'), sessionEnv, command, 'en')).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(csrf.calls.filter((call) => call.method === 'POST')).toEqual([]);
});

test('only emitted profiles at work grain, exact work links, native ISBN and containment semantics are offered', async () => {
  const fixture = publicationFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected work');
  expect(publicationProfiles(fixture.release, 'bf:Instance', 'en')).toEqual([]);
  expect(publicationProfiles(fixture.release, 'rezics:AnimeRelease', 'en')).toEqual([]);
  expect(publicationProfiles(fixture.release, 'schema:Person', 'en')).toEqual([]);
  expect(publicationProfiles(fixture.release, 'schema:VideoGame', 'ja')[0]?.id).toBe('wd:Q20631656');
  expect(publicationProfiles(fixture.release, 'schema:Movie', 'en')[0]?.relations).toEqual([
    'schema:exampleOfWork',
    'bf:hasPart',
  ]);
  const anime = publicationFixture('ready', 'en', 'schema:Movie');
  const animeRead = await anime.transport.load();
  if (!animeRead.ok) throw new Error('Expected film work');
  const anthology = publicationDraft(
    animeRead,
    'rezics:AnimeRelease',
    'bf:hasPart',
    [{ language: 'en', label: 'Film anthology', description: '', aliases: '' }],
    statement('bf:hasPart', anime.work.subject.id),
    [],
    true,
  );
  expect(anthology.errors).toEqual([]);
  expect(anthology.item.statements['bf:hasPart']?.[0]?.value).toEqual({
    type: 'value',
    content: anime.work.subject.id,
  });
  const independent = publicationDraft(
    read,
    'bf:Instance',
    'schema:exampleOfWork',
    [{ language: 'en', label: 'PDF in French', description: '', aliases: '' }],
    statement('schema:exampleOfWork', read.public.subject.id),
    [],
    false,
  );
  expect(independent.errors).toContainEqual({ pointer: '/independent', code: 'required' });
  const bad = draft(read);
  bad.item.statements['schema:exampleOfWork']![0]!.value = { type: 'value', content: publicationCreatedId };
  expect(
    await fixture.transport.submit({
      work: read.public.subject.id,
      relation: 'schema:exampleOfWork',
      item: bad.item,
      key,
    }),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  expect(fixture.calls.filter((call) => call.method === 'POST')).toEqual([]);
  delete fixture.release.types['bf:Instance'];
  expect(publicationProfiles(fixture.release, 'schema:Book', 'en')).toEqual([]);
  const concealed = publicationFixture('concealed');
  expect(await concealed.transport.load()).toEqual({ ok: false, reason: 'concealed' });
  expect(await readPublicationEditor(fixture.client, 'client-invented-work', 'en')).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

test('uncertain retries keep the exact draft/key and a confirmed creation only retries its current ordinary reader', async () => {
  const fixture = publicationFixture('uncertain');
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected work');
  const command = { work: read.public.subject.id, relation: 'schema:exampleOfWork', item: draft(read).item, key };
  expect(await fixture.transport.submit(command)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await fixture.transport.submit(command)).toMatchObject({ ok: true, id: publicationCreatedId });
  const writes = fixture.calls.filter((call) => call.method === 'POST');
  expect(writes[0]?.body).toEqual(writes[1]?.body);
  expect(writes[0]?.key).toBe(writes[1]?.key);
  expect(fixture.receipts.size).toBe(1);
  for (const [scenario, state] of [
    ['reader-unavailable', 'unavailable'],
    ['reader-concealed', 'concealed'],
  ] as const) {
    const delayed = publicationFixture(scenario);
    expect(await delayed.transport.submit(command)).toEqual({ ok: true, id: publicationCreatedId, reader: { state } });
    delayed.setScenario('ready');
    expect(await readCreatedSubject(delayed.client, publicationCreatedId, 'en')).toMatchObject({ state: 'ready' });
    expect(delayed.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  }
});

test('English publication metadata uses its actual requested-language description or an honest existing fallback without changing creation or conflict outcomes', async () => {
  for (const scenario of ['ready', 'conflict'] as const) {
    const fixture = publicationFixture(scenario, 'en');
    const read = await fixture.transport.load();
    if (!read.ok) throw new Error('Expected work');
    const edition = fixture.release.types['bf:Instance']!;
    expect(edition.descriptions?.en).toBeUndefined();
    expect(read.profiles[0]).toMatchObject({
      label: edition.labels.en,
      labelLang: 'en',
      description: edition.descriptions!.de,
      descriptionLang: 'de',
    });
    expect(publicationProfiles(fixture.release, 'schema:Book', 'es')[0]).toMatchObject({
      description: edition.descriptions!.es,
      descriptionLang: 'es',
    });
    expect(publicationProfiles(fixture.release, 'schema:VideoGame', 'en')[0]).toMatchObject({
      description: fixture.release.types['wd:Q20631656']!.descriptions!.en,
      descriptionLang: 'en',
    });
    const result = await fixture.transport.submit({
      work: read.public.subject.id,
      relation: 'schema:exampleOfWork',
      item: draft(read).item,
      key,
    });
    expect(result).toMatchObject(
      scenario === 'ready' ? { ok: true, id: publicationCreatedId } : { ok: false, reason: 'conflict' },
    );
    expect(fixture.receipts.size).toBe(scenario === 'ready' ? 1 : 0);
  }
});
