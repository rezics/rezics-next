import canonicalize from 'canonicalize';
import { SESSION_HEADER } from '../http/request.ts';
import type { FieldError } from '../http/problem.ts';
import { decodeSession, encodeSession, mergeSession } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';

export const MAX_PAGE_READS = 16;

export type PageRead = { kind: 'subject'; id: string } | { kind: 'search'; body: object };

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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function addError(errors: FieldError[], pointer: string, code: FieldError['code']): void {
  errors.push({ pointer, code });
}

function validateReads(reads: unknown): PreparedRead[] {
  const errors: FieldError[] = [];
  if (!isObject(reads)) {
    throw new PageReadError([{ pointer: '/reads', code: 'invalid_type' }]);
  }

  const entries = Object.entries(reads);
  if (entries.length > MAX_PAGE_READS) addError(errors, '/reads', 'out_of_range');

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
      if (typeof descriptor.id !== 'string' || !UUID_PATTERN.test(descriptor.id)) {
        addError(errors, `${pointer}/id`, 'invalid_format');
      } else {
        canonicalDescriptor = { kind: 'subject', id: descriptor.id };
      }
    } else if (descriptor.kind === 'search') {
      if (!isObject(descriptor.body)) {
        addError(errors, `${pointer}/body`, 'invalid_type');
      } else {
        if (Object.hasOwn(descriptor.body, 'cursor')) addError(errors, `${pointer}/body/cursor`, 'unknown_field');
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

  const init: RequestInit = { method: descriptor.kind === 'subject' ? 'GET' : 'POST', headers, redirect: 'manual' };
  if (descriptor.kind === 'search') {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(descriptor.body);
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
  const initialPath = read.descriptor.kind === 'subject' ? `/v1/subjects/${read.descriptor.id}` : '/v1/subjects:search';
  const tokens: string[] = [];
  let response = await dispatch(requestFor(new URL(initialPath, origin), read.descriptor, credentials));
  readToken(response, tokens);

  if (read.descriptor.kind === 'subject' && response.status === 308) {
    const location = response.headers.get('location');
    if (location !== null) {
      let target: URL | undefined;
      try {
        target = new URL(location, new URL(initialPath, origin));
      } catch {
        // An invalid Location leaves the original redirect response as the result.
      }
      if (target?.origin === origin) {
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
}): Promise<{ results: Record<string, PageResult>; session: string | null }> {
  const reads = validateReads(options.reads);
  const unique = new Map<string, PreparedRead>();
  for (const read of reads) if (!unique.has(read.canonical)) unique.set(read.canonical, read);

  const distinctReads = [...unique.values()];
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
  await Promise.all(Array.from({ length: Math.min(4, distinctReads.length) }, () => worker()));
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
