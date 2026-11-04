import { createKernelClient } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { candidateFixture } from './subject-candidates';
import { candidateContext, selectCandidate } from '../../subject/candidates';
import {
  authoredStatement,
  proposeAuthoredField,
  readAuthoredField,
  readAuthoredReview,
  type AuthoredDocument,
  type AuthoredTransport,
} from '../../features/catalogue/authored-field';
import definitions from '../recorded/definitions-release.json';

export type AuthoredScenario =
  | 'ready'
  | 'empty'
  | 'no-selection'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'unavailable'
  | 'actions-unavailable'
  | 'actions-denied'
  | 'lost-response'
  | 'body-unavailable';
export const authoredProperty = 'schema:abstract';

/** Declared samples for isolated stories, layered on the existing review fake; never a runtime success fallback. */
export function authoredFixture(scenario: AuthoredScenario = 'ready', locale = 'en') {
  const base = candidateFixture('ready', locale, authoredProperty);
  const release = structuredClone(definitions.release) as Release;
  if (scenario === 'empty')
    release.types[base.publicRead.subject.type]!.properties = release.types[
      base.publicRead.subject.type
    ]!.properties.filter((property) => release.properties[property]?.datatype !== 'document');
  const documents = new Map<string, AuthoredDocument>();
  const oldId = `${base.id.slice(0, -3)}771`;
  const oldCandidate = `${base.id.slice(0, -3)}770`;
  const newId = `${base.id.slice(0, -3)}772`;
  const body = fromPlainText('An aviator meets a young traveller in the desert.');
  const old = structuredClone(base.candidate.statement);
  old.id = oldCandidate;
  old.property = { id: authoredProperty, data_type: 'document' };
  old.value = { type: 'value', content: { document: oldId, language: 'en', digest: 'b'.repeat(64) } };
  base.publicRead.subject.statements[authoredProperty] = scenario === 'no-selection' ? [] : [old];
  documents.set(oldId, {
    id: oldId,
    subjectId: base.id,
    candidateId: oldCandidate,
    revision: 1,
    origin: 'account',
    author: `${base.id.slice(0, -3)}773`,
    licence: 'CC-BY-4.0',
    language: 'en',
    digest: 'b'.repeat(64),
    availability: 'available',
    body,
  });
  const receipts = new Map<string, { candidate: string; revision: number }>();
  const calls: {
    method: string;
    path: string;
    authorization: string | null;
    session: string | null;
    key: string | null;
    body: unknown;
  }[] = [];
  let lost = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'rezics-session-token': 'authored-session',
      },
    });
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const key = request.headers.get('idempotency-key');
    const body: unknown = request.method === 'POST' ? await request.clone().json() : null;
    calls.push({
      method: request.method,
      path,
      key,
      body,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
    });
    if (path === '/v1/viewerActions' && scenario === 'actions-unavailable')
      return json({ code: 'dependency_unavailable' }, 503);
    if (path === '/v1/viewerActions')
      return json({
        resources: [
          {
            type: 'semantic.context',
            id: candidateContext,
            viewerActions: scenario === 'actions-denied' ? [] : [
              { action: 'context:accept', operations: ['subject.accept_candidate', 'subject.reject_candidate'] },
              { action: 'context:adopt', operations: ['subject.adopt'] },
              { action: 'statement:propose', operations: ['subject.propose'] },
            ],
          },
        ],
      });
    if (path === '/v1/definitions/active') return json({ digest: definitions.digest, head: 1 });
    if (path === `/v1/definitions/releases/${encodeURIComponent(definitions.digest)}`)
      return json({ ...definitions, release });
    if (path.startsWith('/v1/documents/')) {
      if (scenario === 'body-unavailable') return json({ code: 'not_found' }, 404);
      const document = documents.get(path.split('/').at(-1)!);
      return document ? json({ document }) : json({ code: 'not_found' }, 404);
    }
    if (path === `/v1/subjects/${base.id}/candidates` && request.method === 'POST') {
      if (!request.headers.has('authorization') || scenario === 'denied') return json({ code: 'forbidden' }, 403);
      if (scenario === 'invalid') return json({ code: 'invalid_request' }, 400);
      if (scenario === 'stale') return json({ code: 'idempotency_conflict' }, 422);
      if (scenario === 'unavailable') return json({ code: 'dependency_unavailable' }, 503);
      if (key && receipts.has(key)) return json(receipts.get(key), 201);
      const statement = (body as { statement: ReturnType<typeof authoredStatement> }).statement;
      const content = (
        statement.value as { content: { document: DocumentSnapshot; language: string; licence: string } }
      ).content;
      base.candidate.source = null;
      base.candidate.statement = {
        ...base.candidate.statement,
        property: { id: authoredProperty, data_type: 'document' },
        value: { type: 'value', content: { document: newId, language: content.language, digest: 'c'.repeat(64) } },
        qualifiers: [],
        references: statement.references.map((reference, index) => ({
          hash: `authored-reference-${index}`,
          parts: reference.parts.map((part) => ({
            ...part,
            property: { id: part.property.id, data_type: release.properties[part.property.id]!.datatype },
          })),
        })),
      };
      documents.set(newId, {
        id: newId,
        subjectId: base.id,
        candidateId: base.candidate.id,
        revision: 2,
        origin: 'account',
        author: `${base.id.slice(0, -3)}773`,
        licence: content.licence,
        language: content.language,
        digest: 'c'.repeat(64),
        availability: 'available',
        body: structuredClone(content.document),
      });
      const receipt = { candidate: base.candidate.id, revision: 2 };
      if (key) receipts.set(key, receipt);
      if (scenario === 'lost-response' && !lost) {
        lost = true;
        throw new Error('Response lost after commit');
      }
      return json(receipt, 201);
    }
    return base.fetcher(request);
  }) as typeof fetch;
  const client = createKernelClient('https://authored.test', { fetch: fetcher });
  const transport: AuthoredTransport = {
    reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
    read: (property, session) =>
      readAuthoredField(
        client,
        { id: base.id, ...(property ? { property } : {}), ...(session ? { session } : {}) },
        locale,
        'Bearer fixture',
      ),
    propose: (command) => proposeAuthoredField(client, 'Bearer fixture', command),
    review: (property, candidate, cursor, session) =>
      readAuthoredReview(
        client,
        'Bearer fixture',
        { id: base.id, property, candidate, ...(cursor ? { cursor } : {}), ...(session ? { session } : {}) },
        locale,
      ),
  };
  return {
    ...base,
    client,
    release,
    documents,
    calls,
    old,
    transport,
    confirm: (command: Parameters<typeof selectCandidate>[2]) => selectCandidate(client, 'Bearer fixture', command),
  };
}
