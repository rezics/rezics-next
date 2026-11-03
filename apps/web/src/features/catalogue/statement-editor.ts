import type { KernelClient, SubjectRead } from '@rezics/client';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { checkStatementInput, type Violation } from '@rezics/definitions/validate';
import { candidateFailure, type CandidateFailure } from '../../subject/candidates';

type Statement = SubjectRead['subject']['statements'][string][number];
export type SnakInput = Pick<BatchStatement, 'property' | 'value'>;
export type StatementInput = Omit<BatchStatement, 'qualifiers' | 'references'> & {
  qualifiers?: SnakInput[];
  references: { parts: SnakInput[] }[];
};
export type EditorAddress = { id: string; property?: string; statement?: string };
export type EditorRead =
  | CandidateFailure
  | {
      ok: true;
      public: SubjectRead;
      release: Release;
      source: Statement | null;
    };
export type ProposalCommand = { id: string; key: string; statement: StatementInput };

/** A proposal carries a native statement object; an editor read address carries its selected statement id. */
export function proposalInput(value: unknown): ProposalCommand | { invalid: true } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    typeof input.key !== 'string' ||
    !uuid.test(input.key) ||
    Object.keys(input).some((key) => !['id', 'key', 'statement'].includes(key)) ||
    validateStatement(input.statement).length
  )
    return { invalid: true };
  return { id: input.id, key: input.key, statement: input.statement as StatementInput };
}

export type ProposalResult =
  | (CandidateFailure & { errors?: Violation[]; refreshDefinitions?: boolean })
  | {
      ok: true;
      kind: 'proposed-awaiting-review';
      candidate: string;
      revision: number;
      session?: string;
    };
export type EditorTransport = {
  read: () => Promise<EditorRead>;
  propose: (command: ProposalCommand) => Promise<ProposalResult>;
};

const scalarTypes = new Set(['string', 'external-id', 'url', 'monolingualtext', 'time', 'quantity']);
const terms = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
export function editableScalar(definition: PropertyDefinition | undefined): definition is PropertyDefinition {
  return !!definition && !definition.relation && scalarTypes.has(definition.datatype);
}
export function correctionProperty(release: Release, type: string, property: string): boolean {
  return (
    !terms.has(property) &&
    !!release.types[type]?.properties.includes(property) &&
    editableScalar(release.properties[property])
  );
}

/** Read DTO metadata is output-only; retain every semantic value, qualifier and reference part. */
export function statementInput(statement: Statement): StatementInput {
  const snak = (part: Statement['qualifiers'][number]): SnakInput => ({
    property: { id: part.property.id },
    value: structuredClone(part.value),
  });
  return {
    ...snak(statement),
    qualifiers: statement.qualifiers.map(snak),
    references: statement.references.map((reference) => ({ parts: reference.parts.map(snak) })),
    rank: 'normal',
  };
}

/** A private initial fact starts with the existing URL-first citation affordance when it is admitted. */
export function emptyCreationStatement(property: string, release: Release): StatementInput {
  return {
    property: { id: property },
    value: { type: 'value', content: '' },
    qualifiers: [],
    references:
      release.properties['schema:url']?.datatype === 'url'
        ? [
            {
              parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: '' } }],
            },
          ]
        : [],
    rank: 'normal',
  };
}

function hasValue(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (typeof content === 'number' || typeof content === 'boolean') return true;
  if (Array.isArray(content)) return content.some(hasValue);
  if (content && typeof content === 'object')
    return Object.entries(content).some(
      ([key, value]) => !['unit', 'precision', 'calendarmodel', 'language'].includes(key) && hasValue(value),
    );
  return false;
}

/** Omit untouched reference controls while retaining typed falsy values and local object identity. */
export function creationStatement(statement: StatementInput, _release: Release): StatementInput {
  return {
    ...statement,
    ...(statement.qualifiers
      ? {
          qualifiers: statement.qualifiers.filter(
            (part) => part.value.type !== 'value' || hasValue(part.value.content),
          ),
        }
      : {}),
    references: statement.references.flatMap((reference) => {
      const parts = reference.parts.filter((part) => part.value.type !== 'value' || hasValue(part.value.content));
      return parts.length ? [{ ...reference, parts }] : [];
    }),
  };
}

export async function readStatementEditor(client: KernelClient, address: EditorAddress): Promise<EditorRead> {
  try {
    // Independent public reads begin together; no privileged fallback or per-field requests.
    const [subject, active] = await Promise.all([
      client.subjects({ id: address.id }).get(),
      client.definitions.active.get(),
    ]);
    if (subject.status !== 200 || !subject.data) return candidateFailure(subject.status);
    if (subject.data.subject.id !== address.id) return { ok: false, reason: 'stale' };
    if (active.status !== 200 || !active.data) return candidateFailure(active.status);
    const bundle = await client.definitions.releases({ digest: active.data.digest }).get();
    if (bundle.status !== 200 || !bundle.data) return candidateFailure(bundle.status);
    const release = bundle.data.release as Release;
    if (bundle.data.digest !== active.data.digest || !release.types || !release.properties)
      return { ok: false, reason: 'unavailable' };
    if (address.property && !correctionProperty(release, subject.data.subject.type, address.property))
      return { ok: false, reason: 'invalid' };
    const source =
      address.property && address.statement
        ? subject.data.subject.statements[address.property]?.find((item) => item.id === address.statement)
        : undefined;
    if (address.statement && !source) return { ok: false, reason: 'stale' };
    return { ok: true, public: subject.data, release, source: source ?? null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function violations(body: unknown): Violation[] | undefined {
  if (!body || typeof body !== 'object' || !('errors' in body) || !Array.isArray(body.errors)) return;
  const codes = new Set(['required', 'unknown_field', 'invalid_type', 'invalid_format', 'out_of_range', 'unsupported']);
  return body.errors
    .flatMap((error: unknown) => {
      if (
        !error ||
        typeof error !== 'object' ||
        !('pointer' in error) ||
        !('code' in error) ||
        typeof error.pointer !== 'string' ||
        typeof error.code !== 'string' ||
        !codes.has(error.code)
      )
        return [];
      return [{ pointer: error.pointer, code: error.code as Violation['code'] }];
    })
    .slice(0, 16);
}

/** The ordinary native proposal envelope accepts only a statement, never ingestion Source metadata. */
export async function proposeStatement(
  client: KernelClient,
  authorization: string,
  command: ProposalCommand,
  continuity?: { session?: string | undefined; uncertain?: () => void },
): Promise<ProposalResult> {
  try {
    // The native endpoint revalidates current authority and replays its original receipt on uncertain retries.
    const result = await client.subjects({ id: command.id }).candidates.post(
      { statement: command.statement },
      {
        headers: {
          authorization,
          'idempotency-key': command.key,
          ...(continuity?.session ? { 'rezics-session-token': continuity.session } : {}),
        } as { 'idempotency-key': string },
      },
    );
    if (result.status !== 201 || !result.data) {
      if (result.status === 201 || (result.status >= 500 && result.status !== 503)) continuity?.uncertain?.();
      const problem = result.error?.value;
      if (problem && typeof problem === 'object' && 'code' in problem && problem.code === 'idempotency_conflict')
        return { ok: false, reason: 'stale' };
      const errors = violations(result.error?.value);
      return { ...candidateFailure(result.status), ...(errors ? { errors } : {}) };
    }
    const session = new Headers(result.headers).get('rezics-session-token');
    return {
      ok: true,
      kind: 'proposed-awaiting-review',
      candidate: result.data.candidate,
      revision: result.data.revision,
      ...(session ? { session } : {}),
    };
  } catch {
    continuity?.uncertain?.();
    return { ok: false, reason: 'unavailable' };
  }
}

export function validateStatement(statement: unknown, release?: Release): Violation[] {
  return checkStatementInput(statement, release).violations;
}

export { unitSymbols } from '../../subject/quantity-presentation';
