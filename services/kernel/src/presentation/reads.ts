import canonicalize from 'canonicalize';
import { MAX_PAGE_READS, MAX_PAGE_COST, readCost } from '@rezics/composition';
import { SESSION_HEADER } from '../http/request.ts';
import type { FieldError } from '../http/problem.ts';
import { validateSearchLimit } from '../search/service.ts';
import { withPublicStatementReader } from '../semantic/statement-disclosure.ts';
import { decodeSession, encodeSession, mergeSession } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';

export { MAX_PAGE_READS } from '@rezics/composition';

export type PageRead =
  | { kind: 'subject'; id: string }
  | { kind: 'links'; id: string; property: string; filter?: string; type?: string; limit: number }
  | { kind: 'collections'; id: string; limit: number }
  | { kind: 'reactions'; id: string }
  | { kind: 'account'; handle: string }
  | { kind: 'accountThreads'; id: string; threadKind: 'discussion' | 'review'; limit: number }
  | { kind: 'accountPosts'; id: string; limit: number }
  | { kind: 'accountCollections'; id: string; limit: number }
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

type SessionKeys = { ring: KeyRing; scope: string };
type ForwardedCredentials = { authorization: string | null; session: string | null };
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
      unknownFields(descriptor, ['kind', 'id'], pointer, errors);
      if (typeof descriptor.id !== 'string' || !UUID_PATTERN.test(descriptor.id)) {
        addError(errors, `${pointer}/id`, 'invalid_format');
      } else {
        canonicalDescriptor = { kind: 'subject', id: descriptor.id };
      }
    } else if (descriptor.kind === 'links') {
      unknownFields(descriptor, ['kind', 'id', 'property', 'filter', 'type', 'limit'], pointer, errors);
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
          kind: 'links',
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
    } else if (descriptor.kind === 'accountThreads') {
      unknownFields(descriptor, ['kind', 'id', 'threadKind', 'limit'], pointer, errors);
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

  const init: RequestInit = { method: descriptor.kind === 'search' ? 'POST' : 'GET', headers, redirect: 'manual' };
  if (descriptor.kind === 'search') {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(descriptor.body);
  } else if (descriptor.kind === 'links') {
    url.pathname = `/v1/subjects/${descriptor.id}/links`;
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
  } else if (descriptor.kind === 'accountThreads') {
    url.pathname = `/v1/accounts/${descriptor.id}/threads`;
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
}): Promise<{ results: Record<string, PageResult>; session: string | null }> {
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

  const distinctReads = [...unique.values()];
  const cost = distinctReads.reduce(
    (sum, { descriptor }) =>
      sum +
      (descriptor.kind === 'search'
        ? validateSearchLimit((descriptor.body as Record<string, unknown>).limit)
        : readCost(descriptor)),
    0,
  );
  if (cost > MAX_PAGE_COST) throw new PageReadError([{ pointer: '/reads', code: 'out_of_range' }]);
  const origin = new URL(options.incoming.url).origin;
  const credentials = {
    authorization: options.incoming.headers.get('authorization'),
    session: options.incoming.headers.get(SESSION_HEADER),
  };
  const completed = new Array<DispatchResult | undefined>(distinctReads.length);
  const failures = new Array<{ error: unknown } | undefined>(distinctReads.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= distinctReads.length) return;
      try {
        completed[index] = await executeRead(distinctReads[index]!, origin, credentials, options.dispatch);
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

  const byCanonical = new Map<string, PageResult>();
  for (let index = 0; index < distinctReads.length; index++) {
    byCanonical.set(distinctReads[index]!.canonical, completed[index]!.result);
  }

  const resultEntries = reads.map(({ key, canonical }) => [key, byCanonical.get(canonical)!] as const);
  const results = Object.fromEntries(resultEntries) as Record<string, PageResult>;

  let components =
    credentials.session === null
      ? []
      : (decodeSession(options.session.ring, options.session.scope, credentials.session) ?? []);
  let hasSubResponseToken = false;
  for (let index = 0; index < distinctReads.length; index++) {
    for (const token of completed[index]!.tokens) {
      hasSubResponseToken = true;
      const writes = decodeSession(options.session.ring, options.session.scope, token);
      if (!writes) continue;
      for (const write of writes) components = mergeSession(components, write);
    }
  }

  return {
    results,
    session: hasSubResponseToken ? encodeSession(options.session.ring, options.session.scope, components) : null,
  };
}
