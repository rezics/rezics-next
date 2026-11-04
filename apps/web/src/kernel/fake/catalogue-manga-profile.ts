import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  createManga,
  readMangaProfile,
  type MangaItem,
  type MangaTransport,
} from '../../features/catalogue/manga-profile';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { allowedCreateAuthority, identityBinding } from '../../features/catalogue/identity-intake';
import type { StatementInput } from '../../features/catalogue/statement-editor';
import { candidateContext, type Candidate } from '../../subject/candidates';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';
import recording from '../recorded/subject.json';

export const mangaSeriesId = '00000000-0000-4000-8000-00000000d101';
export const mangaVolumeId = '00000000-0000-4000-8000-00000000d102';
export const mangaCreatorId = '00000000-0000-4000-8000-00000000d103';
export const mangaVolumeCitation = 'https://example.org/paper-observatory/volume-2';
export type MangaScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'conflict'
  | 'uncertain'
  | 'saving'
  | 'reader-unavailable'
  | 'reader-concealed';
export function mangaExample(volume = false): MangaItem {
  const statement = (property: string, content: unknown): StatementInput => ({
    property: { id: property },
    value: { type: 'value', content },
    qualifiers: [],
    references: [],
    rank: 'normal',
  });
  return {
    type: volume ? 'schema:PublicationVolume' : 'schema:ComicSeries',
    labels: { en: volume ? 'The Paper Observatory, volume 2' : 'The Paper Observatory', ja: '紙の天文台' },
    descriptions: {},
    aliases: {},
    statements: volume
      ? {
          'wdt:P179': [
            {
              ...statement('wdt:P179', mangaSeriesId),
              qualifiers: [{ property: { id: 'schema:position' }, value: { type: 'value', content: '2' } }],
            },
          ],
          'schema:numberOfPages': [
            {
              ...statement('schema:numberOfPages', { amount: '+192', unit: '1' }),
              // Ordinary replacement proposals retain a statement citation, including in this declared example.
              references: [
                { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: mangaVolumeCitation } }] },
              ],
            },
          ],
          'schema:isbn': [statement('schema:isbn', '9781234567897')],
        }
      : { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] },
  };
}

/** Declared request examples reuse the real generated client and editor helpers; no native-proof claim. */
export function mangaFixture(scenario: MangaScenario = 'ready', locale = 'en') {
  const release = structuredClone(definitions.release) as Release;
  const calls: { method: string; path: string; key: string | null; body: unknown; authorization: string | null }[] = [];
  const receipts = new Map<string, unknown>();
  const candidates = new Map<string, Candidate>();
  let active = scenario;
  let lost = false;
  const base = structuredClone(recording) as unknown as SubjectRead;
  const reads = new Map<string, SubjectRead>();
  function selected(statement: StatementInput): SubjectRead['subject']['statements'][string][number] {
    const snak = (part: { property: { id: string }; value: StatementInput['value'] }) => ({
      ...structuredClone(part),
      property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
    });
    return {
      ...snak(statement),
      id: crypto.randomUUID(),
      rank: statement.rank ?? 'normal',
      qualifiers: (statement.qualifiers ?? []).map(snak),
      references: statement.references.map((reference) => ({
        hash: crypto.randomUUID(),
        parts: reference.parts.map(snak),
      })),
      rezics: { release: definitions.digest, revision: 1 },
    };
  }
  function subject(id: string, item: MangaItem): SubjectRead {
    return {
      account: null,
      summary: null,
      subject: {
        ...structuredClone(base.subject),
        id,
        type: item.type,
        labels: item.labels,
        descriptions: item.descriptions ?? {},
        aliases: item.aliases ?? {},
        sourceRecords: [],
        context: candidateContext,
        revision: 1,
        relationCounts: {},
        resolution: {},
        statements: Object.fromEntries(
          Object.entries(item.statements).map(([property, entries]) => [property, entries.map(selected)]),
        ),
      },
      related: {
        [mangaSeriesId]: { type: 'schema:ComicSeries', labels: mangaExample().labels },
        [mangaCreatorId]: { type: 'schema:Person', labels: { en: 'Mika Sora' } },
      },
    };
  }
  reads.set(mangaSeriesId, subject(mangaSeriesId, mangaExample()));
  reads.set(mangaVolumeId, subject(mangaVolumeId, mangaExample(true)));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'manga-session' },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url),
      path = url.pathname;
    const body = request.method === 'POST' ? await request.json() : null;
    const key = request.headers.get('idempotency-key');
    calls.push({ method: request.method, path, body, key, authorization: request.headers.get('authorization') });
    if (path === '/v1/definitions/active') {
      if (active === 'loading') return new Promise<Response>(() => {});
      if (active === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      return json({ digest: definitions.digest, head: 1 });
    }
    if (path.startsWith('/v1/definitions/releases/')) return json({ digest: definitions.digest, release });
    if (request.method === 'POST') {
      if (!request.headers.has('authorization')) return json({ code: 'forbidden' }, 403);
      if (active === 'saving') return new Promise<Response>(() => {});
      if (active === 'denied') return json({ code: 'forbidden' }, 403);
      if (active === 'stale') return json({ code: 'stale_editorial_head' }, 409);
      if (active === 'conflict') return json({ code: 'idempotency_conflict' }, 422);
      if (active === 'invalid')
        return json({ code: 'invalid_request', errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }, 400);
      if (!receipts.has(key!)) {
        if (path === '/v1/subjects') {
          const item = body as MangaItem;
          const id = item.type === 'schema:PublicationVolume' ? mangaVolumeId : mangaSeriesId;
          const read = subject(id, item);
          reads.set(id, read);
          receipts.set(key!, { subject: read.subject });
        } else if (path.endsWith('/candidates')) {
          const statement = selected((body as { statement: StatementInput }).statement);
          const candidate: Candidate = {
            id: statement.id,
            statement,
            revision: 2,
            release: definitions.digest,
            source: null,
            retracted: null,
            retraction: null,
            decision: null,
            head: null,
            rank: null,
          };
          candidates.set(candidate.id, candidate);
          receipts.set(key!, { candidate: candidate.id, revision: 2 });
        } else return json({ code: 'semantic_not_ready' }, 503);
      }
      if (active === 'uncertain' && !lost) {
        lost = true;
        throw new TypeError('Response lost');
      }
      return json(receipts.get(key!), 201);
    }
    if (path.endsWith('/candidates'))
      return json({
        candidates: [...candidates.values()].filter(
          (candidate) => candidate.statement.property.id === url.searchParams.get('property'),
        ),
        next: null,
        adoption: null,
      });
    const id = path.split('/').at(-1)!;
    if (reads.has(id)) {
      if (receipts.size && active === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (receipts.size && active === 'reader-concealed') return json({ code: 'not_found' }, 404);
      return json(reads.get(id));
    }
    return json({ code: 'not_found' }, 404);
  }) as typeof fetch;
  const client = createKernelClient('https://kernel.invalid', { fetch: fetcher });
  if (scenario === 'empty')
    for (const type of ['schema:ComicSeries', 'schema:PublicationVolume']) delete release.types[type];
  const transport: MangaTransport = {
    load: () => readMangaProfile(client),
    eligibility: async () => allowedCreateAuthority,
    create: (command) =>
      createManga(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  const identityIntake = {
    viewerKey: 'manga-fixture-viewer',
    viewerState: 'signed-in' as const,
    read: async (input: Parameters<typeof identityBinding>[0], generation: number) => ({
      binding: identityBinding(input, generation),
      status: 'empty' as const,
      viewer: { state: 'signed-in' as const },
      actions: {
        openExisting: false,
        continueWithResults: true,
        continueUnverified: false,
        retry: false,
        createAuthority: allowedCreateAuthority,
      },
      results: [],
    }),
  };
  return {
    transport,
    identityIntake,
    client,
    calls,
    receipts,
    release,
    reads,
    fetcher,
    candidates,
    propose: (command: Parameters<typeof proposeFact>[2]) => proposeFact(client, 'Bearer fixture', command),
    setScenario: (next: MangaScenario) => {
      active = next;
    },
  };
}

let story: ReturnType<typeof mangaFixture> | undefined;
export function selectMangaStory(scenario: MangaScenario = 'ready', locale = 'en') {
  story = mangaFixture(scenario, locale);
  return story;
}
export function clearMangaStory() {
  story = undefined;
}
const storyAnswer: NonNullable<FakeRoute['story']> = async ({ request }) => {
  if (!story) return;
  const response = await story.fetcher(request);
  return {
    ...((await response.json()) as Record<string, unknown>),
    status: response.status,
    headers: Object.fromEntries(response.headers),
  };
};
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/subjects\/00000000-0000-4000-8000-00000000d10[12](?:\/candidates)?$/,
    story: storyAnswer,
  },
  {
    method: 'POST',
    path: /^\/v1\/subjects(?:\/00000000-0000-4000-8000-00000000d10[12]\/candidates)?$/,
    story: async (context) => {
      if (context.request.url.endsWith('/v1/subjects')) {
        const item = (await context.request.clone().json()) as MangaItem;
        if (!['schema:ComicSeries', 'schema:PublicationVolume'].includes(item.type)) return;
      }
      return storyAnswer(context);
    },
  },
  { method: 'GET', path: /^\/v1\/definitions\/(?:active|releases\/.*)$/, story: storyAnswer },
];
