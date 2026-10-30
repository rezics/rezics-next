import canonicalize from 'canonicalize';
import {
  MAX_PAGE_READS,
  MAX_PAGE_COST,
  MAX_PAGE_DOCUMENTS,
  pageDocumentReferences,
  readCost,
  type PageDocumentRead,
} from '@rezics/composition';
import { checkDocument, serializeDocument } from '@rezics/document';
import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_BYTES } from '../content/document.ts';
import { SESSION_HEADER } from '../http/request.ts';
import type { FieldError } from '../http/problem.ts';
import { validateSearchLimit } from '../search/service.ts';
import { withPublicStatementReader } from '../semantic/statement-disclosure.ts';
import { decodeSession, encodeSession, mergeSession } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';

export { MAX_PAGE_READS } from '@rezics/composition';

export type PageRead =
  | Exclude<import('@rezics/composition').PageRead, { kind: 'search' }>
  | { kind: 'search'; body: object };

export class PageReadError extends Error {
  readonly errors: FieldError[];

  constructor(errors: FieldError[]) {
    super('Page reads are invalid');
    this.name = 'PageReadError';
    this.errors = [...errors].sort((left, right) =>
      left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0,
    );
  }
}

/** Request-local accounting includes probes, redirect hops and every native document operation. */
export class PageReadBudget {
  reads = 0;
  cost = 0;
  private heldReads = 0;
  private heldCost = 0;
  reserve(reads: number, cost: number): () => void {
    this.admit(reads, cost);
    this.heldReads += reads;
    this.heldCost += cost;
    return () => {
      this.heldReads -= reads;
      this.heldCost -= cost;
    };
  }
  admit(reads: number, cost: number): void {
    if (this.reads + this.heldReads + reads > MAX_PAGE_READS || this.cost + this.heldCost + cost > MAX_PAGE_COST)
      throw new PageReadError([{ pointer: '/reads', code: 'out_of_range' }]);
  }
  charge(cost: number): void {
    this.admit(1, cost);
    this.reads++;
    this.cost += cost;
  }
}

type SessionKeys = { ring: KeyRing; scope: string };
type ForwardedCredentials = { authorization: string | null; session: string | null; language: string | null };
type PageResult = { status: number; body: unknown };
type PreparedRead = {
  key: string;
  descriptor: PageRead;
  canonical: string;
};
type DispatchResult = { result: PageResult; tokens: string[] };

const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const CURIE_PATTERN = /^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$/;
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function addError(errors: FieldError[], pointer: string, code: FieldError['code']): void {
  errors.push({ pointer, code });
}

function unknownFields(
  descriptor: Record<string, unknown>,
  allowed: readonly string[],
  pointer: string,
  errors: FieldError[],
) {
  for (const key of Object.keys(descriptor)) {
    if (!allowed.includes(key)) addError(errors, `${pointer}/${escapePointerSegment(key)}`, 'unknown_field');
  }
}

/** Own JSON data only: canonicalization must never invoke hooks or discard malformed inputs. */
function copyJSON(value: unknown, pointer: string, ancestors = new Set<object>()): unknown {
  const invalid = (): never => {
    throw new PageReadError([{ pointer, code: 'invalid_type' }]);
  };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (typeof value !== 'object') return invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
    ancestors.has(value)
  )
    return invalid();
  ancestors.add(value);
  try {
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return invalid();
      const fieldPointer = `${pointer}/${escapePointerSegment(key)}`;
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (!field.enumerable || !Object.hasOwn(field, 'value'))
        throw new PageReadError([{ pointer: fieldPointer, code: 'invalid_type' }]);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return invalid();
      entries.push([key, copyJSON(field.value, fieldPointer, ancestors)]);
    }
    if (array) {
      if (entries.length !== value.length) return invalid();
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function validateReads(reads: unknown): PreparedRead[] {
  const errors: FieldError[] = [];
  if (!isObject(reads)) {
    throw new PageReadError([{ pointer: '/reads', code: 'invalid_type' }]);
  }

  if (Object.keys(reads).length > MAX_PAGE_READS)
    throw new PageReadError([{ pointer: '/reads', code: 'out_of_range' }]);
  // Take custody before any await, validation or dedup can observe a different input.
  try {
    reads = copyJSON(reads, '/reads');
  } catch (error) {
    if (error instanceof PageReadError) throw error;
    throw new PageReadError([{ pointer: '/reads', code: 'invalid_type' }]);
  }
  const entries = Object.entries(reads as Record<string, unknown>);

  const prepared: PreparedRead[] = [];
  for (const [key, descriptor] of entries) {
    const pointer = `/reads/${escapePointerSegment(key)}`;
    if (!KEY_PATTERN.test(key)) addError(errors, pointer, 'invalid_format');
    if (!isObject(descriptor)) {
      addError(errors, pointer, 'invalid_type');
      continue;
    }

    let canonicalDescriptor: PageRead | undefined;
    if (descriptor.kind === 'subject') {
      unknownFields(descriptor, ['kind', 'id', 'context'], pointer, errors);
      if (typeof descriptor.id !== 'string' || !UUID_PATTERN.test(descriptor.id)) {
        addError(errors, `${pointer}/id`, 'invalid_format');
      } else {
        canonicalDescriptor = {
          kind: 'subject',
          id: descriptor.id,
          ...(typeof descriptor.context === 'string' ? { context: descriptor.context } : {}),
        };
      }
    } else if (descriptor.kind === 'links' || descriptor.kind === 'relations') {
      unknownFields(
        descriptor,
        ['kind', 'id', 'context', 'property', 'filter', 'type', 'limit', 'cursor'],
        pointer,
        errors,
      );
      const idValid = typeof descriptor.id === 'string' && UUID_PATTERN.test(descriptor.id);
      if (!idValid) addError(errors, `${pointer}/id`, 'invalid_format');
      const propertyValid = typeof descriptor.property === 'string' && CURIE_PATTERN.test(descriptor.property);
      if (!propertyValid) addError(errors, `${pointer}/property`, 'invalid_format');
      const filterValid =
        descriptor.filter === undefined ||
        (typeof descriptor.filter === 'string' && UUID_PATTERN.test(descriptor.filter));
      if (!filterValid) addError(errors, `${pointer}/filter`, 'invalid_format');
      const typeValid =
        descriptor.type === undefined || (typeof descriptor.type === 'string' && CURIE_PATTERN.test(descriptor.type));
      if (!typeValid) addError(errors, `${pointer}/type`, 'invalid_format');
      const limitValid =
        Number.isInteger(descriptor.limit) && (descriptor.limit as number) >= 1 && (descriptor.limit as number) <= 24;
      if (!limitValid) addError(errors, `${pointer}/limit`, 'out_of_range');
      if (idValid && propertyValid && filterValid && typeValid && limitValid) {
        canonicalDescriptor = {
          kind: descriptor.kind,
          id: descriptor.id as string,
          property: descriptor.property as string,
          ...(descriptor.filter === undefined ? {} : { filter: descriptor.filter as string }),
          ...(descriptor.type === undefined ? {} : { type: descriptor.type as string }),
          limit: descriptor.limit as number,
        };
      }
    } else if (descriptor.kind === 'collections') {
      unknownFields(descriptor, ['kind', 'id', 'limit'], pointer, errors);
      const idValid = typeof descriptor.id === 'string' && UUID_PATTERN.test(descriptor.id);
      if (!idValid) addError(errors, `${pointer}/id`, 'invalid_format');
      const limitValid =
        Number.isInteger(descriptor.limit) && (descriptor.limit as number) >= 1 && (descriptor.limit as number) <= 6;
      if (!limitValid) addError(errors, `${pointer}/limit`, 'out_of_range');
      if (idValid && limitValid)
        canonicalDescriptor = { kind: 'collections', id: descriptor.id as string, limit: descriptor.limit as number };
    } else if (descriptor.kind === 'reactions') {
      unknownFields(descriptor, ['kind', 'id'], pointer, errors);
      if (typeof descriptor.id !== 'string' || !UUID_PATTERN.test(descriptor.id)) {
        addError(errors, `${pointer}/id`, 'invalid_format');
      } else {
        canonicalDescriptor = { kind: 'reactions', id: descriptor.id };
      }
    } else if (descriptor.kind === 'account') {
      unknownFields(descriptor, ['kind', 'handle'], pointer, errors);
      if (typeof descriptor.handle !== 'string' || !HANDLE_PATTERN.test(descriptor.handle)) {
        addError(errors, `${pointer}/handle`, 'invalid_format');
      } else {
        canonicalDescriptor = { kind: 'account', handle: descriptor.handle };
      }
    } else if (descriptor.kind === 'accountThreads' || descriptor.kind === 'subjectThreads') {
      unknownFields(
        descriptor,
        descriptor.kind === 'subjectThreads'
          ? ['kind', 'id', 'place', 'threadKind', 'limit', 'cursor']
          : ['kind', 'id', 'threadKind', 'limit'],
        pointer,
        errors,
      );
      const idValid = typeof descriptor.id === 'string' && UUID_PATTERN.test(descriptor.id);
      if (!idValid) addError(errors, `${pointer}/id`, 'invalid_format');
      const kindValid = descriptor.threadKind === 'discussion' || descriptor.threadKind === 'review';
      if (!kindValid) addError(errors, `${pointer}/threadKind`, 'invalid_format');
      const limitValid =
        Number.isInteger(descriptor.limit) && (descriptor.limit as number) >= 1 && (descriptor.limit as number) <= 20;
      if (!limitValid) addError(errors, `${pointer}/limit`, 'out_of_range');
      if (idValid && kindValid && limitValid) {
        canonicalDescriptor = {
          kind: 'accountThreads',
          id: descriptor.id as string,
          threadKind: descriptor.threadKind as 'discussion' | 'review',
          limit: descriptor.limit as number,
        };
        if (descriptor.kind === 'subjectThreads') {
          if (typeof descriptor.place !== 'string' || !UUID_PATTERN.test(descriptor.place))
            addError(errors, `${pointer}/place`, 'invalid_format');
          else canonicalDescriptor = { ...canonicalDescriptor, kind: 'subjectThreads', place: descriptor.place };
        }
      }
    } else if (descriptor.kind === 'accountPosts' || descriptor.kind === 'accountCollections') {
      unknownFields(descriptor, ['kind', 'id', 'limit'], pointer, errors);
      const idValid = typeof descriptor.id === 'string' && UUID_PATTERN.test(descriptor.id);
      if (!idValid) addError(errors, `${pointer}/id`, 'invalid_format');
      const maxLimit = descriptor.kind === 'accountPosts' ? 20 : 24;
      const limitValid =
        Number.isInteger(descriptor.limit) &&
        (descriptor.limit as number) >= 1 &&
        (descriptor.limit as number) <= maxLimit;
      if (!limitValid) addError(errors, `${pointer}/limit`, 'out_of_range');
      if (idValid && limitValid) {
        canonicalDescriptor = {
          kind: descriptor.kind,
          id: descriptor.id as string,
          limit: descriptor.limit as number,
        };
      }
    } else if (descriptor.kind === 'search') {
      unknownFields(descriptor, ['kind', 'body'], pointer, errors);
      if (!isObject(descriptor.body)) {
        addError(errors, `${pointer}/body`, 'invalid_type');
      } else {
        if (Object.hasOwn(descriptor.body, 'cursor')) addError(errors, `${pointer}/body/cursor`, 'unknown_field');
        try {
          validateSearchLimit(descriptor.body.limit);
        } catch {
          addError(errors, `${pointer}/body/limit`, 'out_of_range');
        }
        canonicalDescriptor = { kind: 'search', body: descriptor.body };
      }
    } else {
      addError(errors, `${pointer}/kind`, 'invalid_format');
    }

    if (canonicalDescriptor === undefined) continue;
    if (
      canonicalDescriptor.kind === 'subject' ||
      canonicalDescriptor.kind === 'links' ||
      canonicalDescriptor.kind === 'relations'
    ) {
      if (descriptor.context !== undefined) {
        if (typeof descriptor.context !== 'string' || !UUID_PATTERN.test(descriptor.context))
          addError(errors, `${pointer}/context`, 'invalid_format');
        else canonicalDescriptor = { ...canonicalDescriptor, context: descriptor.context };
      }
    }
    if (
      canonicalDescriptor.kind === 'links' ||
      canonicalDescriptor.kind === 'relations' ||
      canonicalDescriptor.kind === 'subjectThreads'
    ) {
      if (descriptor.cursor !== undefined) {
        if (
          typeof descriptor.cursor !== 'string' ||
          descriptor.cursor.length === 0 ||
          (canonicalDescriptor.kind === 'subjectThreads' && descriptor.cursor.length > 4096)
        )
          addError(errors, `${pointer}/cursor`, 'invalid_format');
        else canonicalDescriptor = { ...canonicalDescriptor, cursor: descriptor.cursor };
      }
    }
    let canonical: string | undefined;
    let normalized: unknown;
    try {
      canonical = canonicalize(canonicalDescriptor);
      if (canonical !== undefined) normalized = JSON.parse(canonical) as unknown;
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined) {
      addError(errors, canonicalDescriptor.kind === 'search' ? `${pointer}/body` : pointer, 'invalid_type');
      continue;
    }

    if (!isObject(normalized) || normalized.kind !== canonicalDescriptor.kind) {
      addError(errors, pointer, 'invalid_type');
      continue;
    }
    if (normalized.kind === 'search' && canonicalDescriptor.kind === 'search') {
      if (!isObject(normalized.body)) {
        addError(errors, `${pointer}/body`, 'invalid_type');
        continue;
      }
      if (Object.hasOwn(normalized.body, 'cursor') && !Object.hasOwn(canonicalDescriptor.body, 'cursor')) {
        addError(errors, `${pointer}/body/cursor`, 'unknown_field');
        continue;
      }
    }
    prepared.push({ key, descriptor: normalized as PageRead, canonical });
  }

  if (errors.length > 0) throw new PageReadError(errors);
  return prepared;
}

function requestFor(url: URL, descriptor: PageRead, credentials: ForwardedCredentials): Request {
  const headers = new Headers();
  if (credentials.authorization !== null) headers.set('authorization', credentials.authorization);
  if (credentials.session !== null) headers.set(SESSION_HEADER, credentials.session);
  if (credentials.language !== null) headers.set('accept-language', credentials.language);

  const init: RequestInit = { method: descriptor.kind === 'search' ? 'POST' : 'GET', headers, redirect: 'manual' };
  if (descriptor.kind === 'search') {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(descriptor.body);
  } else if (descriptor.kind === 'links' || descriptor.kind === 'relations') {
    url.pathname = `/v1/subjects/${descriptor.id}/${descriptor.kind}`;
    url.searchParams.set('property', descriptor.property);
    if (descriptor.filter !== undefined) url.searchParams.set('filter', descriptor.filter);
    if (descriptor.type !== undefined) url.searchParams.set('type', descriptor.type);
    url.searchParams.set('limit', String(descriptor.limit));
  } else if (descriptor.kind === 'collections') {
    url.pathname = `/v1/subjects/${descriptor.id}/collections`;
    url.searchParams.set('limit', String(descriptor.limit));
  } else if (descriptor.kind === 'reactions') {
    url.pathname = `/v1/subjects/${descriptor.id}/reactions`;
  } else if (descriptor.kind === 'account') {
    url.pathname = '/v1/accounts';
    url.searchParams.set('handle', descriptor.handle);
  } else if (descriptor.kind === 'accountThreads' || descriptor.kind === 'subjectThreads') {
    url.pathname = `/v1/${descriptor.kind === 'subjectThreads' ? 'subjects' : 'accounts'}/${descriptor.id}/threads`;
    if (descriptor.kind === 'subjectThreads') url.searchParams.set('place', descriptor.place);
    url.searchParams.set('kind', descriptor.threadKind);
    url.searchParams.set('limit', String(descriptor.limit));
  } else if (descriptor.kind === 'accountPosts') {
    url.pathname = `/v1/accounts/${descriptor.id}/posts`;
    url.searchParams.set('limit', String(descriptor.limit));
  } else if (descriptor.kind === 'accountCollections') {
    url.pathname = `/v1/accounts/${descriptor.id}/collections`;
    url.searchParams.set('view', 'BASIC');
    url.searchParams.set('limit', String(descriptor.limit));
  }
  if (
    (descriptor.kind === 'subject' || descriptor.kind === 'links' || descriptor.kind === 'relations') &&
    descriptor.context
  )
    url.searchParams.set('context', descriptor.context);
  if (
    (descriptor.kind === 'links' || descriptor.kind === 'relations' || descriptor.kind === 'subjectThreads') &&
    descriptor.cursor
  )
    url.searchParams.set('cursor', descriptor.cursor);
  return new Request(url, init);
}

function readToken(response: Response, tokens: string[]): void {
  const token = response.headers.get(SESSION_HEADER);
  if (token !== null) tokens.push(token);
}

async function responseResult(response: Response): Promise<PageResult> {
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

async function executeRead(
  read: PreparedRead,
  origin: string,
  credentials: ForwardedCredentials,
  dispatch: (request: Request) => Promise<Response>,
): Promise<DispatchResult> {
  const descriptor = read.descriptor;
  const initialPath =
    descriptor.kind === 'search'
      ? '/v1/subjects:search'
      : descriptor.kind === 'account'
        ? '/v1/accounts'
        : descriptor.kind === 'accountThreads' ||
            descriptor.kind === 'accountPosts' ||
            descriptor.kind === 'accountCollections'
          ? `/v1/accounts/${descriptor.id}`
          : `/v1/subjects/${descriptor.id}`;
  const tokens: string[] = [];
  let response = await dispatch(requestFor(new URL(initialPath, origin), read.descriptor, credentials));
  readToken(response, tokens);

  if (descriptor.kind === 'subject' && response.status === 308) {
    const location = response.headers.get('location');
    if (location !== null) {
      let target: URL | undefined;
      try {
        target = new URL(location, new URL(initialPath, origin));
      } catch {
        // An invalid Location leaves the original redirect response as the result.
      }
      if (
        target?.origin === origin &&
        target.username === '' &&
        target.password === '' &&
        target.search === '' &&
        target.hash === '' &&
        /^\/v1\/subjects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.pathname) &&
        // URL parsing normalizes dot segments and empty query/fragment markers; refuse those too.
        (location === target.pathname || location === `${origin}${target.pathname}`)
      ) {
        response = await dispatch(requestFor(target, read.descriptor, credentials));
        readToken(response, tokens);
      }
    }
  }

  return { result: await responseResult(response), tokens };
}

export async function readPage(options: {
  dispatch: (request: Request) => Promise<Response>;
  incoming: Request;
  reads: Record<string, PageRead>;
  session: SessionKeys;
  languages?: readonly string[];
  documents?: PageDocumentRead;
  observed?: ReadonlyMap<string, PageResult>;
  budget?: PageReadBudget;
}): Promise<{ results: Record<string, PageResult>; session: string | null; documents: Record<string, unknown> }> {
  const reads = validateReads(options.reads).map((read) => {
    if (read.descriptor.kind !== 'search') return read;
    const descriptor: PageRead = {
      kind: 'search',
      body: {
        ...read.descriptor.body,
        limit: validateSearchLimit((read.descriptor.body as Record<string, unknown>).limit),
        ...(options.languages === undefined ? {} : { languages: [...options.languages] }),
      },
    };
    return { ...read, descriptor, canonical: canonicalize(descriptor)! };
  });
  const unique = new Map<string, PreparedRead>();
  for (const read of reads) if (!unique.has(read.canonical)) unique.set(read.canonical, read);

  const budget = options.budget ?? new PageReadBudget();
  const observed = new Map(options.observed);
  let descriptor: PageDocumentRead | undefined;
  if (options.documents) {
    const snapshot = copyJSON(options.documents, '/documents');
    if (
      !isObject(snapshot) ||
      Object.keys(snapshot).some((key) => !['kind', 'id', 'context', 'properties'].includes(key)) ||
      snapshot.kind !== 'documents' ||
      typeof snapshot.id !== 'string' ||
      !UUID_PATTERN.test(snapshot.id) ||
      (snapshot.context !== undefined && (typeof snapshot.context !== 'string' || !UUID_PATTERN.test(snapshot.context))) ||
      !Array.isArray(snapshot.properties) ||
      snapshot.properties.length > 64 ||
      !snapshot.properties.every((property) => typeof property === 'string' && CURIE_PATTERN.test(property))
    )
      throw new PageReadError([{ pointer: '/documents', code: 'invalid_format' }]);
    descriptor = { kind: 'documents', id: snapshot.id, ...(typeof snapshot.context === 'string' ? { context: snapshot.context } : {}), properties: snapshot.properties };
  }
  const nativeCost = (read: PreparedRead) =>
    read.descriptor.kind === 'search'
      ? validateSearchLimit((read.descriptor.body as Record<string, unknown>).limit)
      : readCost(read.descriptor);
  const origin = new URL(options.incoming.url).origin;
  const credentials = {
    authorization: options.incoming.headers.get('authorization'),
    session: options.incoming.headers.get(SESSION_HEADER),
    language: options.languages?.join(',') ?? options.incoming.headers.get('accept-language'),
  };
  const tokens: string[] = [];
  const forwardToken = (token: string | null) => {
    if (token === null) return;
    tokens.push(token);
    let components = credentials.session === null ? [] : (decodeSession(options.session.ring, options.session.scope, credentials.session) ?? []);
    for (const component of decodeSession(options.session.ring, options.session.scope, token) ?? [])
      components = mergeSession(components, component);
    credentials.session = encodeSession(options.session.ring, options.session.scope, components);
  };
  const execute = async (read: PreparedRead): Promise<DispatchResult> => {
    const result = await executeRead(read, origin, credentials, async (request) => {
      budget.charge(nativeCost(read));
      const response = await options.dispatch(new Request(request, { signal: options.incoming.signal }));
      forwardToken(response.headers.get(SESSION_HEADER));
      return response;
    });
    return result;
  };
  // Resolve the dependency first and release its owner connection before document.get.
  if (descriptor) {
    const subject: PageRead = { kind: 'subject', id: descriptor.id, ...(descriptor.context ? { context: descriptor.context } : {}) };
    const canonical = canonicalize(subject)!;
    if (!observed.has(canonical)) {
      const result = await withPublicStatementReader(() => execute({ key: 'subject', descriptor: subject, canonical }));
      observed.set(canonical, result.result);
    }
  }
  const subjectResult = descriptor ? observed.get(canonicalize({ kind: 'subject', id: descriptor.id, ...(descriptor.context ? { context: descriptor.context } : {}) })!) : undefined;
  const subject =
    subjectResult?.status === 200 && isObject(subjectResult.body) ? subjectResult.body.subject : undefined;
  const references =
    descriptor && isObject(subject) && subject.id === descriptor.id
      ? pageDocumentReferences(subject, descriptor.properties, options.languages?.[0] ?? 'en')
      : [];
  const documentIds = [...new Set(references.map((reference) => reference.document))];
  const distinctReads = [...unique.values()].filter((read) => !observed.has(read.canonical));
  // This is the effective dependent plan. Reject it as a whole before any body/list execution; never truncate values.
  if (documentIds.length > MAX_PAGE_DOCUMENTS) throw new PageReadError([{ pointer: '/reads', code: 'out_of_range' }]);
  budget.admit(
    distinctReads.length + documentIds.length,
    distinctReads.reduce((sum, read) => sum + nativeCost(read), 0) + documentIds.length,
  );
  const completed = new Array<DispatchResult | undefined>(distinctReads.length);
  const failures = new Array<{ error: unknown } | undefined>(distinctReads.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= distinctReads.length) return;
      try {
        completed[index] = await execute(distinctReads[index]!);
      } catch (error) {
        failures[index] = { error };
      }
    }
  };
  // Both probes and planned reads use public hydration while retaining caller credentials and authority.
  await withPublicStatementReader(() =>
    Promise.all(Array.from({ length: Math.min(4, distinctReads.length) }, () => worker())),
  );
  const failedAt = failures.findIndex((failure) => failure !== undefined);
  if (failedAt !== -1) throw failures[failedAt]!.error;

  const byCanonical = new Map(observed);
  for (let index = 0; index < distinctReads.length; index++) {
    byCanonical.set(distinctReads[index]!.canonical, completed[index]!.result);
  }

  const documents: Record<string, unknown> = {};
  // Requests are deduplicated by effective native key, then admitted separately against every exact binding.
  for (const id of documentIds) {
    budget.charge(1);
    const headers = new Headers();
    if (credentials.authorization !== null) headers.set('authorization', credentials.authorization);
    if (credentials.session !== null) headers.set(SESSION_HEADER, credentials.session);
    const response = await options.dispatch(
      new Request(new URL(`/v1/documents/${id}`, origin), {
        headers,
        signal: options.incoming.signal,
        redirect: 'manual',
      }),
    );
    forwardToken(response.headers.get(SESSION_HEADER));
    if (response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    const result = await responseResult(response);
    if (result.status !== 200) {
      // Preserve standalone failures rather than turn 301/503 into a successful empty body.
      for (const read of reads) {
        if (read.descriptor.kind === 'subject' && read.descriptor.id === descriptor?.id)
          byCanonical.set(read.canonical, result);
      }
      break;
    }
    const document = isObject(result.body) ? result.body.document : undefined;
    if (!isObject(document) || document.availability !== 'available' || !checkDocument(document.body)) continue;
    const canonical = serializeDocument(document.body);
    if (
      Buffer.byteLength(canonical) > MAX_DOCUMENT_BYTES ||
      createHash('sha256').update(canonical).digest('hex') !== document.digest
    )
      continue;
    for (const reference of references) {
      if (
        document.id === reference.document &&
        document.subjectId === descriptor?.id &&
        document.candidateId === reference.candidate &&
        document.language === reference.language &&
        document.digest === reference.digest
      )
        documents[reference.candidate] = document;
    }
  }

  const resultEntries = reads.map(({ key, canonical }) => [key, byCanonical.get(canonical)!] as const);
  const results = Object.fromEntries(resultEntries) as Record<string, PageResult>;

  let components =
    credentials.session === null
      ? []
      : (decodeSession(options.session.ring, options.session.scope, credentials.session) ?? []);
  let hasSubResponseToken = false;
  {
    for (const token of tokens) {
      hasSubResponseToken = true;
      const writes = decodeSession(options.session.ring, options.session.scope, token);
      if (!writes) continue;
      for (const write of writes) components = mergeSession(components, write);
    }
  }

  return {
    results,
    documents,
    session: hasSubResponseToken ? encodeSession(options.session.ring, options.session.scope, components) : null,
  };
}
