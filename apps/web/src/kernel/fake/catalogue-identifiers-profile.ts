import { createKernelClient, type SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { releaseDigest, type Release } from '@rezics/definitions';
import emitted from '../../../../../packages/definitions/release/rezics.json';
import { readStatementEditor, validateStatement, type StatementInput } from '../../features/catalogue/statement-editor';
import { proposeFact, type FactsTransport } from '../../features/catalogue/subject-facts';
import { identifierProperties } from '../../features/catalogue/identifiers-profile';
import { candidateContext, readCandidates, selectCandidate, type Candidate } from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';

export const identifiersSubject = '00000000-0000-4000-8000-00000000d101';
export const identifiersCandidate = '00000000-0000-4000-8000-00000000d102';
export const identifiersCompetingCandidate = '00000000-0000-4000-8000-00000000d103';
export const identifiersStatement = '00000000-0000-4000-8000-00000000d111';
export const identifiersCitation = 'https://catalogue.example/edition/One?record=A%2Fb&lang=ja#original';
export type IdentifiersScenario =
  | 'ready'
  | 'empty'
  | 'loading'
  | 'signed-out'
  | 'denied'
  | 'unavailable'
  | 'invalid'
  | 'partial'
  | 'uncertain'
  | 'stale'
  | 'continued'
  | 'pending'
  | 'reader-unavailable';

/** Synthetic native-shaped payloads through production adapters; no native execution claim. */
export function identifiersProfileFixture(scenario: IdentifiersScenario = 'ready', locale = 'en') {
  const release = emitted as unknown as Release;
  const digest = releaseDigest(release);
  const snak = (part: Pick<StatementInput, 'property' | 'value'>) => ({
    property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
    value: structuredClone(part.value),
  });
  const statement = (id: string, input: StatementInput): Candidate['statement'] => ({
    ...snak(input),
    id,
    rank: 'normal',
    qualifiers: (input.qualifiers ?? []).map(snak),
    references: input.references.map(({ parts }) => ({ hash: 'synthetic-citation', parts: parts.map(snak) })),
    rezics: { release: digest, revision: 1 },
  });
  const input = (property: string, content: string): StatementInput => ({
    property: { id: property },
    value: { type: 'value', content },
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: identifiersCitation } },
          {
            property: { id: 'schema:name' },
            value: { type: 'value', content: { text: '原本の書誌', language: 'ja' } },
          },
        ],
      },
    ],
    rank: 'normal',
  });
  const publicRead: SubjectRead = {
    subject: {
      id: identifiersSubject,
      type: 'bf:Instance',
      context: candidateContext,
      revision: 1,
      release: digest,
      labels: { en: 'A particular edition', ja: 'ある版' },
      descriptions: {},
      aliases: {},
      statements:
        scenario === 'empty'
          ? {}
          : {
              'schema:isbn': [statement(identifiersStatement, input('schema:isbn', '978-4-00-000000-0'))],
              'schema:sameAs': [
                statement('00000000-0000-4000-8000-00000000d112', input('schema:sameAs', identifiersCitation)),
              ],
            },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    related: {},
    account: null,
    summary: null,
  };
  const calls: {
    path: string;
    query: string;
    method: string;
    body: unknown;
    key: string | null;
    session: string | null;
  }[] = [];
  const candidates: Candidate[] = [];
  const receipts = new Map<string, { candidate: string; revision: number }>();
  let lost = false;
  let adopted = false;
  let adoptionHead = 1;
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { 'rezics-session-token': 'identifier-session' },
    });
  const client = createKernelClient('https://identifiers.invalid', {
    fetch: (async (urlInput, init) => {
      const request = urlInput instanceof Request ? urlInput : new Request(String(urlInput), init);
      const url = new URL(request.url);
      const path = url.pathname;
      const key = request.headers.get('idempotency-key');
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : null;
      calls.push({
        path,
        query: url.search,
        method: request.method,
        body,
        key,
        session: request.headers.get('rezics-session-token'),
      });
      if (path === '/v1/definitions/active') {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        return scenario === 'unavailable' ? json({}, 503) : json({ digest, head: 1 });
      }
      if (path.startsWith('/v1/definitions/releases/'))
        return json({ digest: scenario === 'stale' ? 'sha256:changed' : digest, release });
      if (path === `/v1/subjects/${identifiersSubject}` && request.method === 'GET') {
        if (scenario === 'denied') return json({}, 403);
        if (scenario === 'reader-unavailable' && adopted) return json({}, 503);
        return json(publicRead);
      }
      if (path === `/v1/subjects/${identifiersSubject}/candidates` && request.method === 'GET') {
        const more = scenario === 'continued' && !url.searchParams.has('cursor');
        return json({
          candidates: more
            ? []
            : candidates.filter((item) => item.statement.property.id === url.searchParams.get('property')),
          adoption: { mode: 'replace', head: adoptionHead },
          next: more ? 'exact-native-page' : null,
        });
      }
      if (!request.headers.has('authorization')) return json({}, 401);
      if (path === `/v1/subjects/${identifiersSubject}/candidates` && request.method === 'POST') {
        const proposed = body?.statement as StatementInput;
        if (scenario === 'partial' && proposed.property.id === 'schema:url') return json({}, 403);
        if (scenario === 'invalid')
          return json({ errors: [{ pointer: '/statement/value', code: 'invalid_format' }] }, 422);
        if (key && receipts.has(key)) return json(receipts.get(key), 201);
        if (validateStatement(proposed, release).length) return json({}, 422);
        const id = candidates.length === 0 ? identifiersCandidate : '00000000-0000-4000-8000-00000000d103';
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
          statement: { ...statement(id, proposed), rezics: { release: digest, revision: 2 } },
        });
        if ((scenario === 'ready' || scenario === 'continued') && candidates.length === 1) {
          const competing = structuredClone(candidates[0]!);
          competing.id = identifiersCompetingCandidate;
          competing.decision = 'accepted';
          competing.head = 1;
          competing.statement.id = identifiersCompetingCandidate;
          competing.statement.value = { type: 'value', content: '978-4-00-000002-4' };
          candidates.push(competing);
        }
        const result = { candidate: id, revision: 2 };
        if (key) receipts.set(key, result);
        if (scenario === 'uncertain' && !lost) {
          lost = true;
          throw new TypeError('Synthetic response loss');
        }
        return json(result, 201);
      }
      const candidate = candidates.find(
        (item) => path === `/v1/subjects/${identifiersSubject}/candidates/${item.id}:accept`,
      );
      if (candidate && request.method === 'POST') {
        if (body?.expected_head !== candidate.head) return json({}, 409);
        candidate.decision = 'accepted';
        candidate.head = (candidate.head ?? 0) + 1;
        return json({
          acceptance: { context: candidateContext, candidate: candidate.id, decision: 'accept', head: candidate.head },
          revision: 3,
        });
      }
      if (path === `/v1/subjects/${identifiersSubject}:adopt` && request.method === 'POST') {
        if (body?.expected_head !== adoptionHead) return json({}, 409);
        const selection = body?.selection as { candidate: string; rank: 'normal' | 'preferred' }[];
        if (
          !selection ||
          selection.some((entry) => candidates.find((item) => item.id === entry.candidate)?.decision !== 'accepted')
        )
          return json({}, 422);
        adopted = true;
        adoptionHead++;
        if (scenario !== 'pending') {
          publicRead.subject.statements[String(body?.property)] = selection.map((entry) => ({
            ...structuredClone(candidates.find((item) => item.id === entry.candidate)!.statement),
            rank: entry.rank,
          }));
          for (const item of candidates)
            item.rank = selection.find((entry) => item.id === entry.candidate)?.rank ?? null;
        }
        return json({
          adoption: {
            context: candidateContext,
            property: body?.property,
            mode: 'replace',
            selection,
            head: adoptionHead,
          },
          revision: 4,
        });
      }
      return json({}, 503);
    }) as typeof fetch,
  });
  const transport: FactsTransport = {
    read: () => readStatementEditor(client, { id: identifiersSubject }),
    propose: (command) => proposeFact(client, 'Bearer synthetic', command),
  };
  const review = (property: string, initialSession?: string): CandidateTransport => {
    return {
      reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
      read: async (_property, cursor, session = initialSession) => {
        const result = await readCandidates(
          client,
          'Bearer synthetic',
          identifiersSubject,
          property,
          cursor,
          undefined,
          session,
        );
        if (!result.ok) return result;
        return {
          ...result,
          fields: identifierProperties(release, result.public.subject.type).map((id) => ({
            id,
            label: pickText(release.properties[id]!.labels, locale).text,
            multivalued: release.properties[id]!.multivalued,
          })),
          names: Object.fromEntries(
            Object.entries(release.properties).map(([id, definition]) => [id, definition.labels]),
          ),
        };
      },
      confirm: async (command) => {
        const result = await selectCandidate(client, 'Bearer synthetic', command);
        return result;
      },
    };
  };
  return { client, release, publicRead, calls, candidates, transport, review };
}
