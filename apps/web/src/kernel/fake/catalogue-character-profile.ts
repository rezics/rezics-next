import { createKernelClient, type SubjectRead } from '@rezics/client';
import { releaseDigest, type Release } from '@rezics/definitions';
import emitted from '../../../../../packages/definitions/release/rezics.json';
import { pickText } from '@rezics/composition';
import {
  characterFacts,
  characterType,
  createCharacter,
  readCharacterProfile,
  type CharacterItem,
} from '../../features/catalogue/character-profile';
import type { CharacterProfileProps } from '../../features/catalogue/character-profile-view';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import { relationFixture, relationRole } from './catalogue-relations';
import { readTypeDescriptor } from '../../features/catalogue/type-directory-client';

export type CharacterScenario =
  | 'ready'
  | 'loading'
  | 'denied'
  | 'unavailable'
  | 'invalid'
  | 'stale'
  | 'uncertain'
  | 'reader-unavailable'
  | 'concealed'
  | 'signed-out'
  | 'pending';
export const characterProfileId = relationRole;
export const characterCreatedId = '00000000-0000-4000-8000-00000000c074';

/** Synthetic native request responses exercise the same adapters as the page; they are not runtime evidence. */
export function characterProfileFixture(scenario: CharacterScenario = 'ready', locale = 'en') {
  const release = emitted as unknown as Release;
  const digest = releaseDigest(release);
  const work = relationFixture(scenario === 'pending' ? 'pending' : 'ready', locale);
  const statements: SubjectRead['subject']['statements'] = {
    'schema:height': [
      {
        id: '00000000-0000-4000-8000-00000000a074',
        property: { id: 'schema:height', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+170', unit: 'http://www.wikidata.org/entity/Q174728' } },
        qualifiers: [],
        references: [],
        rank: 'normal',
        rezics: { release: digest, revision: 1 },
      },
    ],
  };
  const character: SubjectRead = {
    subject: {
      id: characterProfileId,
      type: characterType,
      context: candidateContext,
      revision: 1,
      release: digest,
      labels: { en: 'The traveler', ja: '旅人' },
      descriptions: { en: 'A fictional traveler' },
      aliases: { ja: ['旅の人'] },
      statements,
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    summary: null,
    related: {},
  };
  const calls: { path: string; method: string; body: unknown; key: string | null }[] = [];
  const receipts = new Map<string, unknown>();
  const descriptorResponses = new Map<string, { body: unknown; status: number }>();
  const candidates: Candidate[] = [];
  let created: CharacterItem | undefined;
  let lost = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'character-session' },
    });
  const readCreated = (): SubjectRead => ({
    ...character,
    subject: {
      ...character.subject,
      id: characterCreatedId,
      labels: created?.labels ?? {},
      descriptions: created?.descriptions ?? {},
      aliases: created?.aliases ?? {},
      statements: Object.fromEntries(
        Object.entries(created?.statements ?? {}).map(([property, values]) => [
          property,
          values.map((value, index) => ({
            ...value,
            property: { id: property, data_type: release.properties[property]!.datatype },
            id: `00000000-0000-4000-8000-${String(index + 900).padStart(12, '0')}`,
            qualifiers: [],
            references: [],
            rank: 'normal' as const,
            rezics: { release: digest, revision: 1 },
          })),
        ]),
      ),
    },
  });
  const client = createKernelClient('https://character.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const key = request.headers.get('idempotency-key');
      const body = request.method === 'POST' ? await request.json() : null;
      calls.push({ path, method: request.method, body, key });
      if (path.startsWith('/v1/definitionTypes/')) {
        const typeId = decodeURIComponent(path.slice('/v1/definitionTypes/'.length));
        const override = descriptorResponses.get(typeId);
        if (override) return json(override.body, override.status);
        const definition = release.types[typeId];
        if (!definition) return json({}, 404);
        const label = pickText(definition.labels, locale);
        return json({
          typeId,
          releaseDigest: digest,
          label: label.text,
          language: label.lang,
          description: null,
          descriptionLanguage: null,
          definition,
          properties: Object.fromEntries(definition.properties.map((id) => [id, release.properties[id]])),
        });
      }
      if (path === '/v1/definitions/active') {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        if (scenario === 'unavailable') return json({}, 503);
        return json({ digest, head: 1 });
      }
      if (path.startsWith('/v1/definitions/releases/'))
        return json({ digest: scenario === 'stale' ? 'sha256:stale' : digest, release });
      if (path === `/v1/subjects/${work.id}`) return json(work.publicRead);
      if (path === `/v1/subjects/${characterProfileId}` && request.method === 'GET')
        return scenario === 'denied' ? json({}, 403) : json(character);
      if (path === `/v1/subjects/${characterCreatedId}` && request.method === 'GET')
        return scenario === 'reader-unavailable'
          ? json({}, 503)
          : scenario === 'concealed'
            ? json({}, 404)
            : json(readCreated());
      if (request.method === 'POST' && path === '/v1/subjects') {
        if (scenario === 'denied') return json({}, 403);
        if (scenario === 'invalid') return json({ errors: [{ pointer: '/labels/en', code: 'invalid_format' }] }, 400);
        created = body as CharacterItem;
        if (scenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json({ subject: readCreated().subject }, 201);
      }
      if (path === `/v1/subjects/${characterProfileId}/candidates` && request.method === 'GET')
        return json({
          candidates: candidates.filter(
            (candidate) => candidate.statement.property.id === url.searchParams.get('property'),
          ),
          adoption: { mode: 'replace', head: null },
          next: null,
        });
      if (request.method === 'POST' && path.endsWith('/candidates')) {
        if (scenario === 'denied') return json({}, 403);
        if (scenario === 'invalid') return json({}, 400);
        if (key && receipts.has(key)) return json(receipts.get(key), 201);
        const input = (body as { statement: CharacterItem['statements'][string][number] }).statement;
        const snak = (part: NonNullable<typeof input.qualifiers>[number]) => ({
          ...part,
          property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
        });
        const id = `00000000-0000-4000-8000-${String(candidates.length + 700).padStart(12, '0')}`;
        candidates.push({
          id,
          source: null,
          release: digest,
          revision: 2,
          retracted: null,
          retraction: null,
          decision: null,
          head: null,
          rank: null,
          statement: {
            ...snak(input),
            id,
            rank: 'normal',
            qualifiers: (input.qualifiers ?? []).map(snak),
            references: input.references.map((reference) => ({ hash: 'citation', parts: reference.parts.map(snak) })),
            rezics: { release: digest, revision: 2 },
          },
        });
        const result = { candidate: id, revision: 2 };
        if (key) receipts.set(key, result);
        if (scenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return json(result, 201);
      }
      return json({}, 503);
    }) as typeof fetch,
  });
  const request = () =>
    new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } });
  const transport: CharacterProfileProps['transport'] = {
    load: (address) => readCharacterProfile(client, address),
    create: (command) => createCharacter(client, request(), {}, command, locale),
    read: (id) => readCreatedSubject(client, id, locale),
    workType: (typeId) => readTypeDescriptor(client, typeId, locale),
  };
  const props: Omit<CharacterProfileProps, 'locale' | 'id' | 'work'> = {
    session: scenario === 'signed-out' ? 'signed-out' : 'signed-in',
    transport,
    search: async (text) =>
      [
        {
          id: work.id,
          title: pickText(work.publicRead.subject.labels, locale).text,
          types: [work.publicRead.subject.type],
          typeLabel: pickText(release.types[work.publicRead.subject.type]!.labels, locale).text,
          cover: null,
        },
        {
          id: characterProfileId,
          title: pickText(character.subject.labels, locale).text,
          types: [characterType],
          typeLabel: pickText(release.types[characterType]!.labels, locale).text,
          cover: null,
        },
        ...Object.entries(work.publicRead.related).map(([id, value]) => ({
          id,
          title: pickText(value.labels, locale).text,
          types: value.type ? [value.type] : [],
          typeLabel: pickText((value.type ? release.types[value.type]?.labels : undefined) ?? {}, locale).text,
          cover: null,
        })),
      ].filter((entry) => entry.title.toLocaleLowerCase().includes(text.toLocaleLowerCase())),
    facts: () => ({
      read: async () => {
        const read = await transport.load({ id: characterProfileId });
        return read.ok ? characterFacts(read) : read;
      },
      propose: (command) => proposeFact(client, 'Bearer fixture', command),
    }),
    review: (_id, property) => ({
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_field, cursor, session) => {
        const read = await readCandidates(
          client,
          'Bearer fixture',
          characterProfileId,
          property,
          cursor,
          undefined,
          session,
        );
        return read.ok
          ? {
              ...read,
              fields: [
                {
                  id: property,
                  label: pickText(release.properties[property]!.labels, locale).text,
                  multivalued: release.properties[property]!.multivalued,
                },
              ],
              names: Object.fromEntries(Object.entries(release.properties).map(([id, value]) => [id, value.labels])),
            }
          : read;
      },
      confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
    }),
    relations: () => work.transport,
  };
  return { client, release, character, work, transport, props, calls, candidates, descriptorResponses };
}
