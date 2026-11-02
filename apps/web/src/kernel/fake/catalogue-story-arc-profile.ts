import { createKernelClient, type SubjectRead } from '@rezics/client';
import { releaseDigest, type Release } from '@rezics/definitions';
import emitted from '../../../../../packages/definitions/release/rezics.json';
import { pickText } from '@rezics/composition';
import {
  readStoryArcProfile,
  storyArcFacts,
  storyArcType,
  storyArcProperty,
} from '../../features/catalogue/story-arc-profile';
import type { StoryArcProfileProps } from '../../features/catalogue/story-arc-profile-view';
import { proposeFact } from '../../features/catalogue/subject-facts';
import { createTypes } from '../../features/catalogue/create-subject';
import { catalogueCreateFixture, catalogueCreatedId, type CreateScenario } from './catalogue-create';
import { relationFixture } from './catalogue-relations';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import { relationDescriptorReader } from './relation-descriptor';
import {
  readRelationEditor,
  proposeRelation,
  confirmRelation,
  type RelationStatementInput,
} from '../../subject/relation-candidates';

export const storyArcProfileId = '00000000-0000-4000-8000-00000000a262';
export const storyArcSiblingId = '00000000-0000-4000-8000-00000000a263';
export const storyArcCreatedId = catalogueCreatedId;
export type StoryArcScenario =
  | 'ready'
  | 'loading'
  | 'denied'
  | 'unavailable'
  | 'wrong-type'
  | 'stale'
  | 'pending'
  | 'signed-out'
  | 'invalid'
  | 'conflict'
  | 'uncertain'
  | 'saving'
  | 'reader-unavailable'
  | 'concealed'
  | 'partial';

/** Synthetic responses through production adapters; no native execution or publication evidence. */
export function storyArcProfileFixture(scenario: StoryArcScenario = 'ready', locale = 'en') {
  const release = emitted as unknown as Release;
  const digest = releaseDigest(release);
  const creation = catalogueCreateFixture(
    (['invalid', 'conflict', 'uncertain', 'saving', 'reader-unavailable', 'concealed'].includes(scenario)
      ? scenario
      : 'ready') as CreateScenario,
    locale,
  );
  const work = relationFixture(scenario === 'pending' ? 'pending' : 'ready', locale);
  const snak = (property: string, content: string) => ({
    property: { id: property, data_type: release.properties[property]!.datatype },
    value: { type: 'value' as const, content },
  });
  const arc: SubjectRead = {
    subject: {
      id: storyArcProfileId,
      type: storyArcType,
      context: candidateContext,
      revision: 1,
      release: digest,
      labels: { en: 'The journey arc', ja: '旅の編' },
      descriptions: { en: 'A named narrative range' },
      aliases: { ja: ['旅路編'] },
      statements: {
        'schema:keywords': [
          {
            ...snak('schema:keywords', 'journey'),
            id: '00000000-0000-4000-8000-00000000b262',
            qualifiers: [],
            references: [{ hash: 'arc-citation', parts: [snak('schema:url', 'https://example.org/guide')] }],
            rank: 'normal',
            rezics: { release: digest, revision: 1 },
          },
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    summary: null,
    related: {},
  };
  const original = {
    ...snak(storyArcProperty, storyArcProfileId),
    id: work.original.id,
    qualifiers: [snak('schema:position', '2'), snak('rezics:firstPart', '9'), snak('rezics:lastPart', '16')],
    references: [{ hash: 'range-citation', parts: [snak('schema:url', 'https://example.org/episode-guide')] }],
    rank: 'normal' as const,
    rezics: { release: digest, revision: 1 },
  };
  work.publicRead.subject.type = 'schema:TVSeries';
  work.publicRead.subject.release = digest;
  work.publicRead.subject.labels = { en: 'The actual parent series', ja: '親シリーズ' };
  work.publicRead.subject.statements = {
    [storyArcProperty]: [
      original,
      { ...structuredClone(original), id: work.sibling.id, value: { type: 'value', content: storyArcSiblingId } },
    ],
  };
  work.publicRead.subject.sourceRecords = [];
  work.publicRead.related = {
    [storyArcProfileId]: { type: storyArcType, labels: arc.subject.labels },
    [storyArcSiblingId]: { type: storyArcType, labels: { en: 'The next arc' } },
  };
  work.candidate.statement = { ...structuredClone(original), id: work.candidate.id };
  const candidates: Candidate[] = [];
  const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'arc-session' },
    });
  const client = createKernelClient('https://arc.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      calls.push({ method: request.method, path, body, key: request.headers.get('idempotency-key') });
      if (path === '/v1/definitions/active') {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        if (scenario === 'unavailable') return json({}, 503);
        return json({ digest, head: 1 });
      }
      if (path === `/v1/definitions/releases/${encodeURIComponent(digest)}`)
        return json({ digest: scenario === 'stale' ? 'sha256:stale' : digest, release });
      if (path === `/v1/subjects/${work.id}`) return json(work.publicRead);
      if (path === `/v1/subjects/${storyArcProfileId}`) {
        if (scenario === 'denied') return json({}, 403);
        return json(
          scenario === 'wrong-type' ? { ...arc, subject: { ...arc.subject, type: 'schema:PublicationVolume' } } : arc,
        );
      }
      if (path === `/v1/subjects/${storyArcProfileId}/candidates`) {
        if (request.method === 'GET')
          return json({
            candidates: candidates.filter(
              (candidate) => candidate.statement.property.id === url.searchParams.get('property'),
            ),
            adoption: { mode: 'replace', head: null },
            next: null,
          });
        if (scenario === 'denied') return json({}, 403);
        if (scenario === 'invalid') return json({}, 400);
        const statement = (body as { statement: RelationStatementInput }).statement;
        if (scenario === 'partial' && statement.property.id === 'schema:url') return json({}, 403);
        const id = `00000000-0000-4000-8000-${String(9000 + candidates.length).padStart(12, '0')}`;
        const part = (part: RelationStatementInput['qualifiers'][number]) => ({
          ...part,
          property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
        });
        candidates.push({
          id,
          source: null,
          release: digest,
          revision: 2,
          decision: null,
          head: null,
          rank: null,
          retracted: null,
          retraction: null,
          statement: {
            ...part(statement),
            id,
            rank: 'normal',
            qualifiers: statement.qualifiers.map(part),
            references: statement.references.map(({ parts }) => ({ hash: 'citation', parts: parts.map(part) })),
            rezics: { release: digest, revision: 2 },
          },
        });
        return json({ candidate: id, revision: 2 }, 201);
      }
      return json({}, 503);
    }) as typeof fetch,
  });
  const transport: StoryArcProfileProps['transport'] = {
    load: (address) => readStoryArcProfile(client, address),
    creation: { ...creation.transport, definitions: async () => ({ ok: true, types: createTypes(release, locale) }) },
  };
  const props: Omit<StoryArcProfileProps, 'locale' | 'id' | 'work'> = {
    session: scenario === 'signed-out' ? 'signed-out' : 'signed-in',
    transport,
    search: async (text) =>
      [arc, work.publicRead]
        .map(({ subject }) => ({
          id: subject.id,
          title: pickText(subject.labels, locale).text,
          types: [subject.type],
          typeLabel: pickText(release.types[subject.type]!.labels, locale).text,
          cover: null,
        }))
        .filter((entry) => entry.title.toLocaleLowerCase().includes(text.toLocaleLowerCase())),
    facts: () => ({
      read: async () => {
        const read = await transport.load({ id: storyArcProfileId });
        return read.ok ? storyArcFacts(read) : read;
      },
      propose: (command) => proposeFact(client, 'Bearer fixture', command),
    }),
    review: (_id, property) => ({
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_property, cursor, session) => {
        const read = await readCandidates(
          client,
          'Bearer fixture',
          storyArcProfileId,
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
              names: Object.fromEntries(
                Object.entries(release.properties).map(([id, property]) => [id, property.labels]),
              ),
            }
          : read;
      },
      confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
    }),
    relations: (id) =>
      id === work.id
        ? work.transport
        : {
            read: (slot, cursor, session) =>
              readRelationEditor(
                client,
                'Bearer fixture',
                relationDescriptorReader(release),
                id,
                locale,
                slot,
                cursor,
                session,
              ),
            propose: (command) => proposeRelation(client, 'Bearer fixture', relationDescriptorReader(release), command),
            confirm: (command) => confirmRelation(client, 'Bearer fixture', command),
          },
  };
  return { release, client, arc, work, creation, transport, props, candidates, calls, original };
}
