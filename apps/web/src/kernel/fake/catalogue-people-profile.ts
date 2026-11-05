import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import {
  createPeopleProfile,
  readPeopleProfile,
  type PeopleAddress,
  type PeopleItem,
  type PeopleTransport,
} from '../../features/catalogue/people-profile';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { allowedCreateAuthority } from '../../features/catalogue/identity-intake';
import { proposeFact } from '../../features/catalogue/subject-facts';
import type { StatementInput, SnakInput } from '../../features/catalogue/statement-editor';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';

export const peoplePersonId = '00000000-0000-4000-8000-00000000d101';
export const peopleOrganizationId = '00000000-0000-4000-8000-00000000d102';
export const peopleWorkId = '00000000-0000-4000-8000-00000000d103';
export const peopleCreatedId = '00000000-0000-4000-8000-00000000d104';
export const peopleCandidateId = '00000000-0000-4000-8000-00000000d105';
export type PeopleScenario =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'unavailable'
  | 'uncertain'
  | 'reader-unavailable'
  | 'concealed';
export type PeopleMode = 'create' | 'person' | 'organization';

/** Isolated generated-request seam for page interactions, not evidence of native execution. */
export function peopleProfileFixture(scenario: PeopleScenario = 'ready', locale = 'en', mode: PeopleMode = 'create') {
  const release = structuredClone(definitions.release) as Release;
  if (scenario === 'empty') {
    delete release.types['schema:Person'];
    delete release.types['schema:Organization'];
  }
  const calls: { method: string; path: string; key: string | null; body: unknown; authorization: string | null }[] = [];
  const receipts = new Map<string, unknown>();
  const candidates: Candidate[] = [];
  let lost = false;
  let created: PeopleItem | undefined;
  let adoption = 1;
  const nativeStatement = (input: StatementInput, id: string): SubjectRead['subject']['statements'][string][number] => {
    const part = (snak: SnakInput) => ({
      property: { id: snak.property.id, data_type: release.properties[snak.property.id]!.datatype },
      value: structuredClone(snak.value),
    });
    return {
      ...part(input),
      id,
      rank: 'normal',
      qualifiers: (input.qualifiers ?? []).map(part),
      references: input.references.map((reference, index) => ({
        hash: `citation-${index}`,
        parts: reference.parts.map(part),
      })),
      rezics: { release: definitions.digest, revision: 1 },
    };
  };
  const subject = (id: string, type: string, labels: Record<string, string>): SubjectRead => ({
    subject: {
      id,
      type,
      revision: 1,
      release: definitions.digest,
      context: candidateContext,
      labels,
      descriptions: {},
      aliases: {},
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  });
  const person = subject(peoplePersonId, 'schema:Person', { en: 'Mira Sato', ja: '佐藤ミラ' });
  person.subject.aliases = { ja: ['ミラ'] };
  const organization = subject(peopleOrganizationId, 'schema:Organization', { en: 'Paper Lantern Studio' });
  const work = subject(peopleWorkId, 'schema:MusicAlbum', { en: 'Lantern Songs' });
  for (const read of [person, organization])
    read.subject.statements['schema:url'] = [
      nativeStatement(
        {
          property: { id: 'schema:url' },
          value: { type: 'value', content: 'https://example.org/original' },
          qualifiers: [],
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credit' } },
              ],
            },
          ],
        },
        `${read.subject.id.slice(0, -1)}9`,
      ),
    ];
  const id = mode === 'organization' ? peopleOrganizationId : peoplePersonId;
  const current = mode === 'organization' ? organization : person;
  const address: PeopleAddress = mode === 'create' ? { work: peopleWorkId } : { id };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'people-session' },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const key = request.headers.get('idempotency-key');
    const body = request.method === 'POST' ? await request.clone().json() : null;
    calls.push({ method: request.method, path, key, body, authorization: request.headers.get('authorization') });
    if (path === '/v1/definitions/active') {
      if (scenario === 'loading') return new Promise<Response>(() => {});
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      return json({ digest: definitions.digest, head: 1 });
    }
    if (path.startsWith('/v1/definitions/releases/'))
      return json({ digest: scenario === 'stale' ? `sha256:${'0'.repeat(64)}` : definitions.digest, release });
    if (request.method === 'GET' && path === `/v1/subjects/${peopleCreatedId}`) {
      if (scenario === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (scenario === 'concealed') return json({ code: 'not_found' }, 404);
      if (!created) return json({ code: 'not_found' }, 404);
      const read = subject(peopleCreatedId, created.type, created.labels);
      read.subject.descriptions = created.descriptions ?? {};
      read.subject.aliases = created.aliases ?? {};
      read.subject.statements = Object.fromEntries(
        Object.entries(created.statements ?? {}).map(([property, values]) => [
          property,
          values.map((value, index) => nativeStatement(value, `${peopleCreatedId.slice(0, -1)}${index + 6}`)),
        ]),
      );
      return json(read);
    }
    if (request.method === 'GET' && path === `/v1/subjects/${id}/candidates`)
      return json({ candidates, adoption: { mode: 'replace', head: adoption }, next: null });
    const read = [person, organization, work].find((entry) => path === `/v1/subjects/${entry.subject.id}`);
    if (request.method === 'GET' && read) return json(read);
    if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
    if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
    if (scenario === 'invalid')
      return json(
        {
          code: 'invalid_request',
          errors: [{ pointer: '/statements/schema:url/0/value/content', code: 'invalid_format' }],
        },
        400,
      );
    if (key && receipts.has(key))
      return json(receipts.get(key), path.endsWith('/candidates') || path === '/v1/subjects' ? 201 : 200);
    let result: unknown;
    let status = 200;
    if (path === '/v1/subjects') {
      created = body as PeopleItem;
      result = { subject: subject(peopleCreatedId, created.type, created.labels).subject };
      status = 201;
    } else if (path === `/v1/subjects/${id}/candidates`) {
      const statement = (body as { statement: StatementInput }).statement;
      candidates.push({
        id: peopleCandidateId,
        revision: 2,
        release: definitions.digest,
        source: null,
        retracted: null,
        retraction: null,
        decision: null,
        head: null,
        rank: null,
        statement: nativeStatement(statement, peopleCandidateId),
      });
      result = { candidate: peopleCandidateId, revision: 2 };
      status = 201;
    } else if (path === `/v1/subjects/${id}/candidates/${peopleCandidateId}:accept`) {
      const candidate = candidates[0];
      if (!candidate || (body as { expected_head: number | null }).expected_head !== candidate.head)
        return json({ code: 'stale_editorial_head' }, 409);
      candidate.head = (candidate.head ?? 0) + 1;
      candidate.decision = 'accepted';
      result = {
        acceptance: { context: candidateContext, candidate: candidate.id, decision: 'accept', head: candidate.head },
        revision: 3,
      };
    } else if (path === `/v1/subjects/${id}:adopt`) {
      const candidate = candidates[0];
      if (
        !candidate ||
        candidate.decision !== 'accepted' ||
        (body as { expected_head: number }).expected_head !== adoption
      )
        return json({ code: 'stale_editorial_head' }, 409);
      current.subject.statements[candidate.statement.property.id] = [structuredClone(candidate.statement)];
      candidate.rank = 'normal';
      result = {
        adoption: {
          context: candidateContext,
          property: candidate.statement.property.id,
          mode: 'replace',
          selection: [{ candidate: candidate.id, rank: 'normal' }],
          head: ++adoption,
        },
        revision: 4,
      };
    } else return json({ code: 'not_found' }, 404);
    if (key) receipts.set(key, result);
    if (scenario === 'uncertain' && !lost) {
      lost = true;
      throw new TypeError('Response lost after commit');
    }
    return json(result, status);
  }) as typeof fetch;
  const client = createKernelClient('https://people.test', { fetch: fetcher });
  const transport: PeopleTransport = {
    load: () => readPeopleProfile(client, locale, address),
    eligibility: async () => allowedCreateAuthority,
    create: (command) =>
      createPeopleProfile(
        client,
        new Request('https://site.invalid/api', {
          method: 'POST',
          headers: { authorization: 'Bearer fixture' },
        }),
        {},
        command,
        locale,
      ),
    read: (createdId) => readCreatedSubject(client, createdId, locale),
  };
  const review = (property: string, initialSession?: string): CandidateTransport => {
    return {
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_property, cursor, session = initialSession) => {
        const result = await readCandidates(client, 'Bearer fixture', id, property, cursor, undefined, session);
        if (!result.ok) return result;
        return {
          ...result,
          fields: [
            {
              id: property,
              label: pickText(release.properties[property]?.labels ?? {}, locale).text,
              multivalued: release.properties[property]?.multivalued ?? false,
            },
          ],
          names: Object.fromEntries(
            Object.entries(release.properties).map(([key, property]) => [key, property.labels]),
          ),
        };
      },
      confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
    };
  };
  return {
    id,
    current,
    person,
    organization,
    work,
    release,
    client,
    fetcher,
    calls,
    receipts,
    candidates,
    transport,
    review,
    propose: (command: Parameters<typeof proposeFact>[2]) => proposeFact(client, 'Bearer fixture', command),
  };
}

let selected: ReturnType<typeof peopleProfileFixture> | undefined;
export function selectPeopleProfileStory(scenario: PeopleScenario, locale: string, mode: PeopleMode) {
  selected = peopleProfileFixture(scenario, locale, mode);
}
async function answer(request: Request) {
  if (!selected) return;
  const response = await selected.fetcher(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, ...body, headers: Object.fromEntries(response.headers) };
}
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/subjects\/00000000-0000-4000-8000-00000000d10[1-4]$/,
    story: ({ request }) => answer(request),
  },
  {
    method: 'POST',
    path: '/v1/subjects',
    story: async ({ request }) => {
      if (!selected) return;
      const body = (await request.clone().json()) as { type?: string };
      return body.type === 'schema:Person' || body.type === 'schema:Organization' ? answer(request) : undefined;
    },
  },
];
