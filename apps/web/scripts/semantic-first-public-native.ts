import { randomUUID } from 'node:crypto';
import { type CompositionDocument, type ZoneStarter } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import { slug } from '@rezics/definitions/slug';
import bookStarter from '../../../packages/definitions/presentation/book/zone.json';

export type Json = Record<string, unknown>;
export type KernelOptions = {
  bearer?: string | undefined;
  body?: unknown;
  ifMatch?: string | undefined;
  query?: Record<string, string> | undefined;
};
export type KernelAnswer = { status: number; headers: Headers; body: Json; etag?: string | undefined };
export type KernelCall = (method: string, path: string, options?: KernelOptions) => Promise<KernelAnswer>;

export const CITATION = 'https://example.test/first-public-evidence';
export const MINUTE = 'http://www.wikidata.org/entity/Q7727';

export function cited(property: string, content: unknown) {
  return {
    property: { id: property },
    value: { type: 'value' as const, content },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: CITATION } }],
      },
    ],
  };
}

export function citedDocument(property: string, text: string, language = 'en') {
  return cited(property, { language, document: fromPlainText(text), licence: 'CC-BY-4.0' });
}

export function citedQuantity(property: string, amount: string, unit: string) {
  return cited(property, { amount, unit });
}

export function staticPage(text: string): CompositionDocument {
  return {
    root: { props: {} },
    content: [{ type: 'Text', props: { id: 'copy', text } }],
  };
}

export function staticZone(label: string, home: string, about: string): ZoneStarter {
  const configuration = structuredClone(bookStarter) as ZoneStarter;
  configuration.scope = [];
  configuration.labels = { ...configuration.labels, en: label, 'zh-Hant': label, ja: label };
  configuration.pages = [
    { route: '', document: staticPage(home) },
    { route: 'about', document: staticPage(about) },
  ];
  return configuration;
}

export function subjectHref(id: string, label: string, locale = 'en', view?: string): string {
  const path = `/${locale}/subjects/${id}/${slug(label)}`;
  return view ? `${path}/${view}` : path;
}

export function requireStatus(answer: KernelAnswer, expected: number, label: string): Json {
  if (answer.status !== expected) {
    throw new Error(`${label} returned HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 800)}`);
  }
  return answer.body;
}

export function requireId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error(`${label} is not a native identity`);
  return value;
}

export function subjectId(body: Json): string {
  const subject = body.subject as Json | undefined;
  return requireId(subject?.id, 'subject');
}

export function subjectRevision(body: Json): string {
  const subject = body.subject as Json | undefined;
  const revision = subject?.revision;
  if (typeof revision === 'number') return String(revision);
  if (typeof revision === 'string' && revision.length > 0) return revision;
  throw new Error('subject revision missing');
}

export async function createSubject(
  call: KernelCall,
  bearer: string,
  type: string,
  label: string,
  statements?: Record<string, unknown[]>,
): Promise<{ id: string; revision: string; body: Json }> {
  const body: Json = { type, labels: { en: label } };
  if (statements && Object.keys(statements).length) body.statements = statements;
  const created = await call('POST', '/v1/subjects', { bearer, body });
  requireStatus(created, 201, `create ${type}`);
  return { id: subjectId(created.body), revision: subjectRevision(created.body), body: created.body };
}

export async function readSubject(call: KernelCall, id: string, bearer?: string): Promise<KernelAnswer> {
  return call('GET', `/v1/subjects/${id}`, bearer === undefined ? {} : { bearer });
}

export async function propose(
  call: KernelCall,
  bearer: string,
  subject: string,
  statement: unknown,
): Promise<{ candidate: string; revision: number }> {
  const proposed = await call('POST', `/v1/subjects/${subject}/candidates`, { bearer, body: { statement } });
  requireStatus(proposed, 201, 'propose candidate');
  const candidate = requireId(proposed.body.candidate, 'candidate');
  const revision = proposed.body.revision;
  if (typeof revision !== 'number') throw new Error('proposal revision missing');
  return { candidate, revision };
}

const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';

export async function acceptCandidate(call: KernelCall, bearer: string, subject: string, candidate: string) {
  requireStatus(
    await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, {
      bearer,
      body: { context: GLOBAL_CONTEXT, expected_head: null },
    }),
    200,
    'accept candidate',
  );
}

export async function adoptCandidate(
  call: KernelCall,
  bearer: string,
  subject: string,
  candidate: string,
  property: string,
  rank: 'normal' | 'preferred' | 'deprecated' = 'normal',
) {
  requireStatus(
    await call('POST', `/v1/subjects/${subject}:adopt`, {
      bearer,
      body: {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        selection: [{ candidate, rank }],
        expected_head: null,
      },
    }),
    200,
    'adopt candidate',
  );
}

export async function patchTerms(
  call: KernelCall,
  bearer: string,
  id: string,
  revision: string,
  patch: { labels?: Record<string, string | null>; descriptions?: Record<string, string | null> },
) {
  const updated = await call('PATCH', `/v1/subjects/${id}/terms`, { bearer, body: patch, ifMatch: revision });
  requireStatus(updated, 200, 'patch terms');
  return updated;
}

export async function deleteCandidate(call: KernelCall, bearer: string, subject: string, candidate: string) {
  requireStatus(
    await call('DELETE', `/v1/subjects/${subject}/candidates/${candidate}`, { bearer }),
    200,
    'delete candidate',
  );
}

export async function restoreCandidate(call: KernelCall, bearer: string, subject: string, candidate: string) {
  requireStatus(
    await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:restoreDeleted`, { bearer, body: {} }),
    200,
    'restore candidate',
  );
}

export async function discloseStatement(call: KernelCall, bearer: string, candidate: string) {
  return call('POST', `/v1/statements/${candidate}/disclose`, { bearer });
}

export async function retractStatement(call: KernelCall, bearer: string, candidate: string) {
  return call('POST', `/v1/statements/${candidate}/retract`, { bearer });
}

export async function createContext(call: KernelCall, bearer: string, label: string) {
  const created = await call('POST', '/v1/contexts', { bearer, body: { labels: { en: label } } });
  requireStatus(created, 201, 'create Context');
  const context = created.body.context as Json | undefined;
  return { id: requireId(context?.id, 'Context'), body: created.body };
}

export async function createStaticZone(call: KernelCall, bearer: string, label: string, home: string, about: string) {
  const configuration = staticZone(label, home, about);
  const created = await call('POST', '/v1/zones', {
    bearer,
    body: { configuration, mounts: [], visibility: 'private' },
  });
  requireStatus(created, 201, 'create Zone');
  const zone = created.body.zone as Json;
  return {
    id: requireId(zone.id, 'Zone'),
    revision: String(zone.revision),
    configuration,
  };
}

export async function saveZoneConfiguration(
  call: KernelCall,
  bearer: string,
  id: string,
  revision: string,
  configuration: ZoneStarter,
) {
  const saved = await call('PUT', `/v1/zones/${id}/configuration`, {
    bearer,
    body: { configuration, mounts: [] },
    ifMatch: revision,
  });
  requireStatus(saved, 200, 'save Zone configuration');
  return String((saved.body.zone as Json).revision);
}

export async function publishZone(call: KernelCall, bearer: string, id: string, revision: string) {
  const published = await call('POST', `/v1/zones/${id}:publish`, {
    bearer,
    body: { visibility: 'public' },
    ifMatch: revision,
  });
  requireStatus(published, 200, 'publish Zone');
  return String((published.body.zone as Json).revision);
}

export async function readZonePage(call: KernelCall, id: string, route = '', bearer?: string) {
  return call('POST', `/v1/zones/${id}:readPage`, {
    ...(bearer === undefined ? {} : { bearer }),
    body: { target: { route } },
  });
}

export async function deleteZone(call: KernelCall, bearer: string, id: string, revision: string) {
  return call('DELETE', `/v1/zones/${id}`, { bearer, ifMatch: revision });
}

export async function restoreZone(call: KernelCall, bearer: string, id: string, revision: string) {
  return call('POST', `/v1/zones/${id}:restore`, { bearer, body: {}, ifMatch: revision });
}

export async function takedownZone(call: KernelCall, bearer: string, id: string, revision: string, pointer: string) {
  return call('POST', `/v1/zones/${id}:takedown`, {
    bearer,
    body: { pointers: [pointer] },
    ifMatch: revision,
  });
}

export async function searchType(call: KernelCall, type: string, limit = 8, bearer?: string) {
  return call('POST', '/v1/subjects:search', {
    ...(bearer === undefined ? {} : { bearer }),
    body: { filter: { type: { in: [type] } }, sort: 'id', limit },
  });
}

export function handleCall(
  handle: (request: Request) => Promise<Response>,
  bearerFor: (token: string) => string,
): KernelCall {
  return async (method, path, options = {}) => {
    const url = new URL(path, 'http://kernel.test');
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const headers: Record<string, string> = {};
    if (options.bearer) headers.authorization = `Bearer ${bearerFor(options.bearer)}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = JSON.stringify(randomUUID());
    if (options.ifMatch) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await handle(
      new Request(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    const text = await response.text();
    const etag = response.headers.get('etag') ?? undefined;
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Json) : {},
      ...(etag === undefined ? {} : { etag }),
    };
  };
}

export { slug };
