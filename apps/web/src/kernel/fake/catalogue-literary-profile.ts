import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  createLiteraryWork,
  readLiteraryProfile,
  type LiteraryCommand,
  type LiteraryItem,
  type LiteraryType,
} from '../../features/catalogue/literary-profile';
import { readCreatedSubject } from '../../features/catalogue/create-subject-request';
import { allowedCreateAuthority } from '../../features/catalogue/identity-intake';
import { proposeFact, type FactsTransport } from '../../features/catalogue/subject-facts';
import { readStatementEditor, type SnakInput, type StatementInput } from '../../features/catalogue/statement-editor';
import type { LiteraryTransport } from '../../features/catalogue/literary-profile-view';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';

export const literaryWorkId = '00000000-0000-4000-8000-00000000b001';
export const literaryCandidateId = '00000000-0000-4000-8000-00000000b002';
export type LiteraryScenario =
  | 'ready'
  | 'loading'
  | 'metadata-unavailable'
  | 'empty'
  | 'denied'
  | 'stale'
  | 'invalid'
  | 'uncertain'
  | 'reader-unavailable'
  | 'concealed';
export const literaryRelease = definitions.release as Release;
export const literaryWords: StatementInput = {
  property: { id: 'schema:wordCount' },
  value: { type: 'value', content: { amount: '+12000', unit: '1' } },
  qualifiers: [],
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/bibliography' } },
      ],
    },
  ],
  rank: 'normal',
};
const initial = (type: LiteraryType): LiteraryItem => ({
  type,
  labels: { en: 'An original literary work', ja: '原語の作品名' },
  descriptions: { en: 'A bibliographic demonstration' },
  aliases: { ja: ['別名'] },
  statements: type === 'schema:Book' ? { 'schema:wordCount': [literaryWords] } : {},
});
function subject(item: LiteraryItem): SubjectRead {
  const snak = (part: SnakInput) => ({
    property: { id: part.property.id, data_type: literaryRelease.properties[part.property.id]!.datatype },
    value: structuredClone(part.value),
  });
  return {
    subject: {
      id: literaryWorkId,
      type: item.type,
      revision: 1,
      release: definitions.digest,
      context: '00000000-0000-8000-8000-000000000000',
      labels: item.labels,
      descriptions: item.descriptions ?? {},
      aliases: item.aliases ?? {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
      statements: Object.fromEntries(
        Object.entries(item.statements).map(([property, statements]) => [
          property,
          statements.map((statement, index) => ({
            ...snak(statement),
            id: `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, '0')}`,
            rank: 'normal' as const,
            qualifiers: (statement.qualifiers ?? []).map(snak),
            references: statement.references.map((reference, at) => ({
              hash: String(at),
              parts: reference.parts.map(snak),
            })),
            rezics: { release: definitions.digest, revision: 1 },
          })),
        ]),
      ),
    },
    related: {},
    summary: null,
    account: null,
  };
}

/** Native-shaped request seam only; proposals never change the public read in this fixture. */
export function literaryFixture(
  scenario: LiteraryScenario = 'ready',
  locale = 'en',
  type: LiteraryType = 'schema:Book',
  editing = false,
) {
  const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const receipts = new Map<string, LiteraryItem>();
  let item = initial(type);
  let lost = false;
  let created = false;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', 'rezics-session-token': 'literary-session' },
    });
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = decodeURIComponent(new URL(request.url).pathname);
      const body: unknown = request.method === 'POST' ? await request.json() : null;
      const key = request.headers.get('idempotency-key');
      calls.push({ method: request.method, path, body, key });
      if (path.startsWith('/v1/definitions/')) {
        if (scenario === 'loading') return new Promise<Response>(() => {});
        if (scenario === 'metadata-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        if (path.endsWith('/active')) return json({ digest: definitions.digest, head: 1 });
        if (scenario === 'empty') return json({ ...definitions, release: { ...literaryRelease, types: {} } });
        return json(definitions);
      }
      if (request.method === 'POST') {
        if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
        if (scenario === 'stale') return json({ code: 'idempotency_conflict' }, 409);
        if (scenario === 'invalid')
          return json(
            { code: 'invalid_request', errors: [{ pointer: '/statements/schema:wordCount', code: 'unsupported' }] },
            422,
          );
        if (path === '/v1/subjects') {
          item = receipts.get(key!) ?? structuredClone(body as LiteraryItem);
          receipts.set(key!, item);
          created = true;
          if (scenario === 'uncertain' && !lost) {
            lost = true;
            throw new TypeError('Response lost');
          }
          return json({ subject: subject(item).subject }, 201);
        }
        if (path === `/v1/subjects/${literaryWorkId}/candidates`)
          return json({ candidate: literaryCandidateId, revision: 2 }, 201);
      }
      if (path === `/v1/subjects/${literaryWorkId}`) {
        if (created && scenario === 'reader-unavailable') return json({ code: 'semantic_not_ready' }, 503);
        if (scenario === 'concealed') return json({ code: 'not_found' }, 404);
        return json(subject(item));
      }
      return json({ code: 'semantic_not_ready' }, 503);
    }) as typeof fetch,
  });
  const transport: LiteraryTransport = {
    load: () => readLiteraryProfile(client, editing ? literaryWorkId : undefined),
    eligibility: async () => allowedCreateAuthority,
    submit: (command) =>
      createLiteraryWork(
        client,
        new Request('https://site.invalid/api', { method: 'POST', headers: { authorization: 'Bearer fixture' } }),
        {},
        command as LiteraryCommand,
        locale,
      ),
    read: (id) => readCreatedSubject(client, id, locale),
  };
  const facts: FactsTransport = {
    read: () => readStatementEditor(client, { id: literaryWorkId }),
    propose: (command) => proposeFact(client, 'Bearer fixture', command),
  };
  // Comparison is explicitly unavailable in this small seam. Actual route stories use the native review actions.
  const review = (): CandidateTransport => ({
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async () => ({ ok: false, reason: 'unavailable' }),
    confirm: async () => ({ ok: false, reason: 'unavailable' }),
  });
  return { transport, facts, review, client, calls, receipts, publicRead: () => subject(item) };
}

// A real route story reads the same identity through the application's ordinary fake HTTP dispatcher.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/subjects/${literaryWorkId}`,
    story: () => ({ status: 200, ...subject(initial('schema:Book')) }),
  },
];
