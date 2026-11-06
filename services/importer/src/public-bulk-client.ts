import type { ReviewedSubjectRead } from './import-client.ts';
import { isDeepStrictEqual } from 'node:util';

export const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest = /^[0-9a-f]{64}$/;
const releaseDigest = /^sha256:[0-9a-f]{64}$/;
/** The only Subject read 503 that means "not current yet"; any other 503 is terminal for the reader. */
export const SUBJECT_NOT_READY_TYPE = 'https://rezics.com/problems/semantic_not_ready';

/** A public read that Semantic reports as not ready. Callers observe the same Subject again later. */
export class ReviewedSubjectNotReady extends Error {
  readonly subject: string;

  constructor(subject: string) {
    super(`Public subject ${subject} is not ready`);
    this.name = 'ReviewedSubjectNotReady';
    this.subject = subject;
  }
}

export type PublicBulkClient = Readonly<{
  readSubject(id: string, signal?: AbortSignal): Promise<ReviewedSubjectRead>;
  readSelectedSynopsis(id: string, query: string, signal?: AbortSignal): Promise<ReviewedSubjectRead>;
}>;

export type SelectedSynopsisDocument = { document: string; digest: string; language: string };

export type SelectedSynopsisSupport =
  | { kind: 'matched'; statement: string; context: string; release: string; references: unknown }
  | { kind: 'changed' | 'missing' | 'unsupported' | 'unavailable' };

function closed(row: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(row).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Build the generated Subject query from a current Global statement. Never invent document operands. */
export function selectedSynopsisQueryFromPublic(
  read: ReviewedSubjectRead,
  statementId: string,
): { query: string; document: SelectedSynopsisDocument } | undefined {
  const subject = read.subject as {
    id?: unknown;
    context?: unknown;
    release?: unknown;
    statements?: Record<string, unknown[]>;
  };
  if (
    typeof subject.id !== 'string' ||
    !subjectId.test(subject.id) ||
    !subjectId.test(statementId) ||
    subject.context !== GLOBAL_CONTEXT ||
    typeof subject.release !== 'string' ||
    !releaseDigest.test(subject.release)
  )
    return;
  const rows = subject.statements?.['schema:abstract'] ?? [];
  const statement = rows.find((row) => isRecord(row) && row.id === statementId);
  if (
    !isRecord(statement) ||
    !['normal', 'preferred'].includes(String(statement.rank)) ||
    !isRecord(statement.property) ||
    statement.property.id !== 'schema:abstract' ||
    statement.property.data_type !== 'document' ||
    !isRecord(statement.value) ||
    statement.value.type !== 'value'
  )
    return;
  const content = statement.value.content;
  if (
    !isRecord(content) ||
    typeof content.document !== 'string' ||
    !subjectId.test(content.document) ||
    typeof content.digest !== 'string' ||
    !digest.test(content.digest) ||
    typeof content.language !== 'string' ||
    content.language.length === 0 ||
    content.language.length > 35
  )
    return;
  const query = JSON.stringify({
    statement: statementId,
    document: content.document,
    digest: content.digest,
    language: content.language,
    context: GLOBAL_CONTEXT,
    release: subject.release,
  });
  if (new TextEncoder().encode(query).byteLength > 2048) return;
  return {
    query,
    document: { document: content.document, digest: content.digest, language: content.language },
  };
}

function redactCurrentSnak(value: unknown): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    !closed(value, ['property', 'value']) ||
    !isRecord(value.property) ||
    !closed(value.property, ['id', 'data_type']) ||
    typeof value.property.id !== 'string' ||
    typeof value.property.data_type !== 'string' ||
    !isRecord(value.value)
  )
    return;
  if (value.value.type === 'value') {
    if (!closed(value.value, ['type', 'content']) || !Object.hasOwn(value.value, 'content')) return;
  } else if (!['somevalue', 'novalue'].includes(String(value.value.type)) || !closed(value.value, ['type'])) return;
  return {
    property: value.property,
    value:
      value.property.data_type === 'document' || value.property.data_type === 'media'
        ? { type: 'somevalue' }
        : value.value,
  };
}

/** Project the exact public statement into the same redacted shape as the native selected-slot result. */
function currentSelectedFact(value: unknown, statementId: string): Record<string, unknown> | undefined {
  if (
    !isRecord(value) ||
    value.id !== statementId ||
    !['normal', 'preferred'].includes(String(value.rank)) ||
    !isRecord(value.property) ||
    !closed(value.property, ['id', 'data_type']) ||
    value.property.id !== 'schema:abstract' ||
    value.property.data_type !== 'document' ||
    !isRecord(value.value) ||
    value.value.type !== 'value' ||
    !isRecord(value.value.content) ||
    !Array.isArray(value.qualifiers) ||
    !Array.isArray(value.references)
  )
    return;
  const content = value.value.content;
  if (
    typeof content.document !== 'string' ||
    typeof content.digest !== 'string' ||
    typeof content.language !== 'string'
  )
    return;
  if (value.qualifiers.length > 16 || value.references.length > 16) return;
  const qualifiers = value.qualifiers.map(redactCurrentSnak);
  if (qualifiers.some((snak) => !snak)) return;
  const references: Record<string, unknown>[] = [];
  for (const reference of value.references) {
    if (
      !isRecord(reference) ||
      !closed(reference, ['hash', 'parts']) ||
      typeof reference.hash !== 'string' ||
      !Array.isArray(reference.parts) ||
      reference.parts.length > 16
    )
      return;
    const parts = reference.parts.map(redactCurrentSnak);
    if (parts.some((snak) => !snak)) return;
    references.push({ hash: reference.hash, parts });
  }
  return {
    id: value.id,
    rank: value.rank,
    property: { id: value.property.id, data_type: value.property.data_type },
    value: { type: 'somevalue' },
    qualifiers,
    references,
  };
}

/** Independent current Global comparison. Document operands stay out of the closed result. */
export function admitSelectedSynopsisSupport(
  read: ReviewedSubjectRead,
  statementId: string,
  document: SelectedSynopsisDocument,
): SelectedSynopsisSupport {
  const value = (read as { selectedSynopsis?: unknown }).selectedSynopsis;
  if (!isRecord(value) || typeof value.kind !== 'string') return { kind: 'unavailable' };
  if (value.kind !== 'matched') {
    if (
      value.kind === 'changed' ||
      value.kind === 'missing' ||
      value.kind === 'unsupported' ||
      value.kind === 'unavailable'
    )
      return closed(value, ['kind']) ? { kind: value.kind } : { kind: 'unavailable' };
    return { kind: 'unavailable' };
  }
  const subject = read.subject as {
    id?: unknown;
    context?: unknown;
    release?: unknown;
    statements?: Record<string, unknown[]>;
  };
  const context = value.context;
  const release = value.release;
  if (
    !closed(value, ['kind', 'fact', 'context', 'release']) ||
    context !== GLOBAL_CONTEXT ||
    context !== subject.context ||
    typeof release !== 'string' ||
    release !== subject.release ||
    !isRecord(value.fact) ||
    value.fact.id !== statementId
  )
    return { kind: 'unavailable' };
  const current = (subject.statements?.['schema:abstract'] ?? []).find((row) =>
    isRecord(row) ? row.id === statementId : false,
  );
  const expected = currentSelectedFact(current, statementId);
  const content = isRecord(current) && isRecord(current.value) ? current.value.content : undefined;
  if (
    !expected ||
    !isRecord(content) ||
    content.document !== document.document ||
    content.digest !== document.digest ||
    content.language !== document.language ||
    !closed(value.fact, ['id', 'rank', 'property', 'value', 'qualifiers', 'references']) ||
    !isDeepStrictEqual(value.fact, expected)
  )
    return { kind: 'unavailable' };
  const serialized = JSON.stringify(value.fact);
  if (serialized.includes(document.document) || serialized.includes(document.digest)) return { kind: 'unavailable' };
  if (!isRecord(value.fact.value) || value.fact.value.type !== 'somevalue') return { kind: 'unavailable' };
  return {
    kind: 'matched',
    statement: statementId,
    context,
    release,
    references: value.fact.references,
  };
}

async function readCurrentSubject(
  fetcher: typeof fetch,
  origin: URL,
  id: string,
  signal: AbortSignal | undefined,
  selectedSynopsis?: string,
): Promise<ReviewedSubjectRead> {
  if (!subjectId.test(id)) throw new TypeError('Invalid public subject identity');
  if (
    selectedSynopsis !== undefined &&
    (selectedSynopsis.length === 0 || new TextEncoder().encode(selectedSynopsis).byteLength > 2048)
  )
    throw new TypeError('Invalid selected synopsis query');
  const visited = new Set<string>();
  let current = id;
  while (!visited.has(current)) {
    visited.add(current);
    const url = new URL(`/v1/subjects/${current}`, origin);
    url.searchParams.set('context', GLOBAL_CONTEXT);
    if (selectedSynopsis !== undefined) url.searchParams.set('selectedSynopsis', selectedSynopsis);
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });
    if (response.status === 308) {
      const body = (await response.json()) as { redirect?: { from?: unknown; to?: unknown } };
      if (body.redirect?.from !== current || typeof body.redirect.to !== 'string' || !subjectId.test(body.redirect.to))
        throw new TypeError('Invalid public subject redirect');
      if (selectedSynopsis !== undefined) throw new TypeError('Selected synopsis cannot follow a canonical redirect');
      // Native identity redirects address Subjects on this API, never a foreign Location URL.
      current = body.redirect.to;
      continue;
    }
    if (!response.ok) {
      // A non-JSON 503 from a proxy carries no problem type and stays an ordinary failure.
      const problem =
        response.status === 503 ? ((await response.json().catch(() => null)) as { type?: unknown } | null) : null;
      if (problem?.type === SUBJECT_NOT_READY_TYPE) throw new ReviewedSubjectNotReady(current);
      throw new Error(`Public subject read returned ${response.status}`);
    }
    const body = (await response.json()) as ReviewedSubjectRead;
    if (body?.subject?.id !== current) throw new TypeError('Public subject read returned a different identity');
    return body;
  }
  throw new TypeError('Cyclic public subject redirect');
}

/** A viewer read with no account token or review context attached. */
export function createPublicBulkClient(options: { origin: string; fetch?: typeof fetch }): PublicBulkClient {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
    throw new TypeError('Invalid public API origin');
  const fetcher = options.fetch ?? fetch;

  return {
    async readSubject(id, signal) {
      return readCurrentSubject(fetcher, origin, id, signal);
    },
    async readSelectedSynopsis(id, query, signal) {
      return readCurrentSubject(fetcher, origin, id, signal, query);
    },
  };
}
