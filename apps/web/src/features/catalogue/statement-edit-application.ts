import type { KernelClient, SubjectRead } from '@rezics/client';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { checkStatementInput, type Violation } from '@rezics/definitions/validate';
import { candidateContext, candidateFailure } from '../pages/visit-host-port';
import {
  type CandidateViewerActions,
  type ViewerActionComponent,
  nativeOperationAvailability,
} from '../../subject/candidate-contract';
import type {
  EditorAddress,
  EditorRead,
  EditorReload,
  ProposalCommand,
  ProposalDecision,
  ProposalResult,
  SnakInput,
  StatementInput,
} from './statement-editor-contract';

type Statement = SubjectRead['subject']['statements'][string][number];

export type {
  EditorAddress,
  EditorRead,
  EditorReload,
  EditorTransport,
  ProposalCommand,
  ProposalDecision,
  ProposalResult,
  SnakInput,
  StatementFieldsRead,
  StatementInput,
  StatementRelated,
  StatementScalarRead,
} from './statement-editor-contract';

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

const notRequested = { state: 'not-requested' } as const;
const unavailableActions = (reason: 'not-found' | 'unavailable' = 'unavailable'): ViewerActionComponent => ({
  state: 'unavailable',
  reason,
});

/** Read the exact subject and Global Context operations in one bounded native batch. */
export async function readCorrectionActions(
  client: KernelClient,
  authorization: string | undefined,
  id: string,
): Promise<CandidateViewerActions> {
  if (!authorization) return { subject: notRequested, context: notRequested };
  try {
    const refs = [
      { type: 'semantic.subject', id },
      { type: 'semantic.context', id: candidateContext },
    ];
    const result = await client.viewerActions.post(
      { resources: refs },
      { headers: { authorization }, fetch: { cache: 'no-store' } },
    );
    if (result.status !== 200 || !result.data || result.data.resources.length !== refs.length) {
      return { subject: unavailableActions(), context: unavailableActions() };
    }
    const component = (type: string, resourceId: string): ViewerActionComponent => {
      const matches = result.data!.resources.filter((resource) => resource.type === type && resource.id === resourceId);
      if (matches.length !== 1) return unavailableActions();
      const resource = matches[0]!;
      if (!('viewerActions' in resource)) return unavailableActions('not-found');
      if (
        !Array.isArray(resource.viewerActions) ||
        resource.viewerActions.some(
          (entry) =>
            !entry ||
            typeof entry.action !== 'string' ||
            !Array.isArray(entry.operations) ||
            entry.operations.some((operation) => typeof operation !== 'string'),
        )
      )
        return unavailableActions();
      return {
        state: 'available',
        actions: resource.viewerActions.map((entry) => ({ action: entry.action, operations: [...entry.operations] })),
      };
    };
    return {
      subject: component('semantic.subject', id),
      context: component('semantic.context', candidateContext),
    };
  } catch {
    return { subject: unavailableActions(), context: unavailableActions() };
  }
}

export function correctionProposalAvailability(actions?: CandidateViewerActions) {
  const subject = actions?.subject;
  if (!subject || subject.state !== 'available') return 'unavailable' as const;
  return nativeOperationAvailability(actions.context, 'statement:propose', 'subject.propose');
}

export function correctionInspectionAvailability(actions?: CandidateViewerActions) {
  return nativeOperationAvailability(actions?.subject, 'subject:read', 'subject.list_candidates');
}

const scalarTypes = new Set(['string', 'external-id', 'url', 'monolingualtext', 'time', 'quantity']);
const terms = new Set(['schema:name', 'schema:description', 'schema:alternateName']);
export function editableScalar(definition: PropertyDefinition | undefined): definition is PropertyDefinition {
  return !!definition && !definition.relation && scalarTypes.has(definition.datatype);
}
export function correctionProperty(
  release: Pick<Release, 'types' | 'properties'>,
  type: string,
  property: string,
): boolean {
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
export function emptyCreationStatement(property: string, release: Pick<Release, 'properties'>): StatementInput {
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
export function creationStatement(statement: StatementInput, _release?: Pick<Release, 'properties'>): StatementInput {
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

export async function readStatementEditor(
  client: KernelClient,
  address: EditorAddress,
  authorization?: string,
): Promise<EditorRead> {
  try {
    // Independent public reads begin together; no privileged fallback or per-field requests.
    const [subject, active, actions] = await Promise.all([
      client.subjects({ id: address.id }).get(),
      client.definitions.active.get(),
      readCorrectionActions(client, authorization, address.id),
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
    return { ok: true, public: subject.data, release, source: source ?? null, actions };
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

export function initialEditorDraft(read: EditorRead): StatementInput | null {
  return read.ok && read.source ? statementInput(read.source) : null;
}

/**
 * A reload must keep the same subject, type and selected statement. Missing labels, related
 * summaries or a Type that is no longer in the release make the editor unavailable rather than
 * silently switching identity.
 */
export function matchEditorRead(next: EditorRead, original: Extract<EditorRead, { ok: true }> | undefined): EditorRead {
  if (!next.ok) return next;
  const subject = next.public?.subject;
  if (
    !subject ||
    !subject.labels ||
    !subject.statements ||
    !next.public.related ||
    !next.release?.types ||
    !next.release.properties ||
    !next.release.types[subject.type]
  )
    return { ok: false, reason: 'unavailable' };
  if (
    original &&
    (subject.id !== original.public.subject.id ||
      subject.type !== original.public.subject.type ||
      next.source?.id !== original.source?.id ||
      next.source?.property.id !== original.source?.property.id)
  )
    return { ok: false, reason: 'stale' };
  if (next.source) {
    if (!correctionProperty(next.release, subject.type, next.source.property.id))
      return { ok: false, reason: 'invalid' };
    if (validateStatement(statementInput(next.source)).length) return { ok: false, reason: 'unavailable' };
  }
  return next;
}

/** Apply a transport read to the open editor: keep an in-progress draft, seed one from a newly admitted source. */
export function applyEditorReload(
  next: EditorRead,
  original: Extract<EditorRead, { ok: true }> | undefined,
  draft: StatementInput | null,
): EditorReload {
  const read = matchEditorRead(next, original);
  if (read.ok && !draft && read.source) {
    const seeded = statementInput(read.source);
    return { read, draft: seeded, baseline: seeded };
  }
  return { read };
}

export function proposalDecision(
  draft: StatementInput,
  release: Release | undefined,
  availability: ReturnType<typeof correctionProposalAvailability>,
): ProposalDecision {
  if (availability !== 'allowed') return { blocked: true };
  const errors = validateStatement(draft, release);
  if (errors.length) return { errors };
  return { ready: true };
}

/** The view adapter supplies the receipt key; the application never draws ambient identity. */
export function proposalFromDraft(id: string, draft: StatementInput, key: string): ProposalCommand {
  return { id, statement: structuredClone(draft), key };
}
