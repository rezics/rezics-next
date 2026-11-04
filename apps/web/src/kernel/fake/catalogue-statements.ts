import { createKernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { candidateFixture, candidateProperty } from './subject-candidates';
import definitions from '../recorded/definitions-release.json';
import { readCandidates, selectCandidate, type CandidateRead, type CandidateViewerActions } from '../../subject/candidates';
import {
  readStatementEditor,
  proposeStatement,
  type StatementInput,
  type SnakInput,
} from '../../features/catalogue/statement-editor';
import type { CandidateTransport } from '../../subject/candidate-review';
import { pickText } from '@rezics/composition';
import type { FakeRoute } from '../fake-modules';

export type StatementScenario =
  | 'ready'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'unavailable'
  | 'lost-response'
  | 'unknown-field-once';

/** Extend the existing review fake, retaining its native acceptance/adoption and public reader. */
export function statementFixture(scenario: StatementScenario = 'ready', locale = 'en', property = candidateProperty) {
  const base = candidateFixture(property === 'schema:inLanguage' ? 'multiple' : 'ready', locale);
  const release = definitions.release as Release;
  const source = base.publicRead.subject.statements[property]![0]!;
  // The proposal stories start with a cited selection, reusing the review fixture's native citation.
  source.references = structuredClone(base.candidate.statement.references);
  const address = { id: base.id, property, statement: source.id };
  const calls: {
    path: string;
    method: string;
    key: string | null;
    body: unknown;
    authorization: string | null;
    session: string | null;
  }[] = [];
  const receipts = new Map<string, { candidate: string; revision: number }>();
  let lost = false;
  let unknownFieldRejected = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'rezics-session-token': 'statement-session',
      },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.clone().json() : null;
    const key = request.headers.get('idempotency-key');
    calls.push({
      path,
      method: request.method,
      key,
      body,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
    });
    if (path === '/v1/definitions/active') return json({ digest: definitions.digest, head: 1 });
    // Generated clients percent-encode the digest's colon as a path parameter.
    if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`) return json(definitions);
    if (path === `/v1/definitions/releases/${definitions.digest}`) return json(definitions);
    if (path === `/v1/subjects/${base.id}/candidates` && request.method === 'POST') {
      if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
      if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'invalid')
        return json(
          { code: 'invalid_request', errors: [{ pointer: '/statement/value/content/time', code: 'invalid_format' }] },
          400,
        );
      if (scenario === 'unknown-field-once' && !unknownFieldRejected) {
        unknownFieldRejected = true;
        return json(
          { code: 'invalid_request', errors: [{ pointer: '/statement/serverOnly', code: 'unknown_field' }] },
          400,
        );
      }
      if (scenario === 'stale') return json({ code: 'stale_editorial_head' }, 409);
      if (scenario === 'unavailable') return json({ code: 'semantic_not_ready' }, 503);
      if (key && receipts.has(key)) return json(receipts.get(key), 201);
      const statement = (body as { statement: StatementInput }).statement;
      const snak = (part: SnakInput) => ({
        property: { ...part.property, data_type: release.properties[part.property.id]!.datatype },
        value: structuredClone(part.value),
      });
      base.candidate.source = null;
      base.candidate.statement = {
        ...base.candidate.statement,
        ...snak(statement),
        qualifiers: (statement.qualifiers ?? []).map(snak),
        references: statement.references.map((reference, index) => ({
          hash: String(index),
          parts: reference.parts.map(snak),
        })),
      };
      const result = { candidate: base.candidate.id, revision: 2 };
      if (key) receipts.set(key, result);
      if (scenario === 'lost-response' && !lost) {
        lost = true;
        throw new Error('Response lost after commit');
      }
      return json(result, 201);
    }
    return base.fetcher(request);
  }) as typeof fetch;
  const client = createKernelClient('https://statements.test', { fetch: fetcher });
  const actions: CandidateViewerActions = {
    subject: {
      state: 'available',
      actions: [{ action: 'subject:read', operations: ['subject.list_candidates'] }],
    },
    context: {
      state: 'available',
      actions: [
        { action: 'statement:propose', operations: ['subject.propose'] },
        { action: 'context:accept', operations: ['subject.accept_candidate', 'subject.reject_candidate'] },
        { action: 'context:adopt', operations: ['subject.adopt'] },
      ],
    },
  };
  const editor = {
    read: async () => {
      const result = await readStatementEditor(client, address);
      return result.ok ? { ...result, actions } : result;
    },
    propose: (command: Parameters<typeof proposeStatement>[2]) => proposeStatement(client, 'Bearer fixture', command),
  };
  const review: CandidateTransport = {
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: async (property = address.property, cursor, session): Promise<CandidateRead> => {
      const result = await readCandidates(client, 'Bearer fixture', base.id, property, cursor, undefined, session);
      return result.ok
        ? {
            ...result,
            fields: [
              {
                id: property,
                label: pickText(release.properties[property]!.labels, locale).text,
                multivalued: release.properties[property]!.multivalued,
              },
            ],
            names: Object.fromEntries(
              Object.entries(release.properties).map(([id, definition]) => [id, definition.labels]),
            ),
            actions,
          }
        : result;
    },
    confirm: (command) => selectCandidate(client, 'Bearer fixture', command),
  };
  return { ...base, client, address, release, source, editor, review, calls };
}

export const routes: FakeRoute[] = [];
