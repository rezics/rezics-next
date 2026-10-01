import { createHash } from 'node:crypto';
import type { Static } from 'typebox';
import type { targetRef } from '../target/contract.ts';

/** G-506 exports targetRef, rather than a separately named ResourceRef type. */
export type ResourceRef = Static<typeof targetRef>;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const EDITORIAL_COST = { candidateBytes: 1_048_576, evidenceRefs: 32,
  baseHeads: 32, messageChars: 4000, pageSize: 50, jsonDepth: 32, requiredApprovals: 2, commands: 2048 } as const;

export interface EditorialTarget {
  resource: ResourceRef;
  context: ResourceRef | 'urn:rezics:context:global';
  /** Exact admitted resource revision, independent of the component base heads. */
  revision: ResourceRef;
  work: ResourceRef | null;
}
export interface BaseHead { component: string; head: string | null }
export interface EvidenceRef { resource: string; revision: string; locator: string | null }
export interface Proposal {
  id: string; kind: string; target: EditorialTarget; proposer: ResourceRef;
  /** Private, proposal-scoped operator/principal comparison key. Never serialize. */
  proposerKey: string;
  latestRevision: number;
  decision: TerminalDecision | null;
}
export interface ProposalRevision {
  proposal: string; n: number; candidate: Json; candidateDigest: string;
  /** Retained owner snapshot for preview and compensation; clients cannot assert it. */
  before: Json;
  baseHeads: BaseHead[]; evidence: EvidenceRef[];
  /** Server-computed binding to the existing owner command admission. */
  ownerCommand?: { action: string; scope: string; digest: string };
}
export type ReviewOutcome = 'approve' | 'request_changes' | 'comment';
export interface ProposalReview {
  id: string; proposal: string; revision: number; reviewer: ResourceRef;
  /** Same private comparison domain as proposerKey, derived by Access. */
  reviewerKey: string;
  outcome: ReviewOutcome; message: string;
  /** Owner-assigned monotonic order, never a client timestamp. */
  sequence: string;
}
export type Blocker =
  | { code: 'stale_revision'; latestRevision: number }
  | { code: 'stale_base'; expectedHeads: BaseHead[]; actualHeads: BaseHead[] }
  | { code: 'self_review' }
  | { code: 'review_authority_required' }
  | { code: 'owner_authority_required'; action: string; scope: string }
  | { code: 'owner_command_refused'; key: string; reason: string }
  | { code: 'required_approvals'; required: number; received: number }
  | { code: 'terminal_decision'; outcome: TerminalDecision['outcome'] }
  | { code: 'owner_unavailable' }
  | { code: 'revision_required' }
  | { code: 'budget_exhausted' }
  | { code: 'apply_pending'; operationKey: string };
export class EditorialBlocked extends Error {
  constructor(readonly blocker: Blocker) { super(blocker.code); }
}
export class EditorialInvalid extends Error {}
export class EditorialReceiptInvalid extends Error {}

export interface OwnerReceipt {
  receipt: string;
  proposal: string; revision: number; candidateDigest: string;
  operationKey: string;
  beforeHeads: BaseHead[]; afterHeads: BaseHead[];
  /** Verified retained candidate/prestate binding, so compensation needs only
   * this receipt rather than accepting another candidate from its caller. */
  candidate: Json; before: Json;
  /** Opaque owner receipt payload, retained for the kind's compensation. */
  owner: Json;
  commands?: CommandOutcome[];
}
export interface TerminalDecision {
  proposal: string; revision: number; actor: ResourceRef;
  outcome: 'applied' | 'rejected' | 'withdrawn';
  receipt: OwnerReceipt | null;
  /** A reversal links to an applied proposal; it never edits that decision. */
  reverts: string | null;
}
export interface ValidatedCandidate {
  candidate: Json; before: Json; baseHeads: BaseHead[];
  ownerCommand?: ProposalRevision['ownerCommand'];
}
export interface PreviewChange { path: string; before: Json; after: Json }

/** Access issues this proof after locking the exact proposal/revision and current
 * authority. The OWNER must validate it and receipt absence in its effect commit.
 * A route, an adapter or a client cannot manufacture decision authority. */
export interface EditorialWritePermit {
  proof: string;
  proposal: string; revision: number; candidateDigest: string;
  decidingAgent: ResourceRef;
}
export interface ApplyInput {
  /** Durable admission locator supplied only for receipt recovery. */
  admissionId?: string;
  target: EditorialTarget; revision: ProposalRevision;
  expectedHeads: BaseHead[];
  /** Stable across lost acknowledgements and a new HTTP retry key. */
  operationKey: string;
  permit: EditorialWritePermit;
  commands?: OrderedCommandJournal;
  /** Receipt-only recovery never grants permission to dispatch. */
  resumeDelivery?: boolean;
}
export interface OwnerCommand { action: string; scope: string; digest: string }
export interface CommandOutcome {
  key: string; outcome: 'applied' | 'rejected' | 'dependency_rejected';
  receipt: string | null; result: Json;
}
export interface CommandDelivery {
  input: ApplyInput; key: string; binding: OwnerCommand; admissionId?: string;
}
/** The immutable ordered keys are retained before any delivery. Bindings may
 * depend on an earlier owner's allocated IRI; the journal retains that exact
 * binding before admission, tied to the approved candidate digest. */
export interface EditorialCommand {
  key: string;
  /** Current owner authority can be read before delivery, even when the exact
   * digest depends on an earlier command's newly allocated resource. */
  authority?(): Promise<Pick<OwnerCommand, 'action' | 'scope'> | null>;
  prepare(settled: readonly CommandOutcome[]): Promise<OwnerCommand>;
  execute(delivery: CommandDelivery, settled: readonly CommandOutcome[]): Promise<CommandOutcome | null>;
  resolve(delivery: CommandDelivery, settled: readonly CommandOutcome[]): Promise<CommandOutcome | null>;
}
export interface OrderedCommandJournal {
  plan(input: ApplyInput, keys: readonly string[]): Promise<void>;
  read(input: ApplyInput, position: number): Promise<{ binding: OwnerCommand | null;
    admissionId?: string; outcome: CommandOutcome | null }>;
  bind(input: ApplyInput, position: number, binding: OwnerCommand): Promise<void>;
  settle(input: ApplyInput, position: number, outcome: CommandOutcome): Promise<void>;
}
export type ApplyOutcome =
  | { outcome: 'applied'; receipt: OwnerReceipt }
  | { outcome: 'refused'; blocker: Extract<Blocker, { code: 'owner_command_refused' }> }
  | { outcome: 'stale_base'; actualHeads: BaseHead[] }
  | { outcome: 'pending' };

/** Kinds own candidate meaning and one guarded owner command, never lifecycle
 * states or review policy. Add <kind>-adapter.ts exporting adapterModule; discovery
 * requires no shared registry edit. Identity merge requires two approvals. */
export interface EditorialAdapter {
  kind: string;
  requiredApprovals: 1 | 2;
  /** Declare only when every delivery registers through the shared Access
   * editorial admission lock/mapping. Its absence then proves no owner delivery.
   * Other owner mechanisms must resolve their own fate, never infer cancellation
   * from a missing graph admission. This is an owner binding, not a kind state. */
  admission?: 'access';
  /** Advisory current owner authority; dispatch independently rechecks it. */
  applyBlockers?(target: EditorialTarget, revision: ProposalRevision, agent: ResourceRef): Promise<Blocker[]>;
  validate(target: EditorialTarget, candidate: unknown, expectedHeads: BaseHead[]): Promise<ValidatedCandidate>;
  preview(revision: ProposalRevision): Promise<PreviewChange[]>;
  apply(input: ApplyInput): Promise<ApplyOutcome>;
  /** Shared ordered delivery; adapters supply owner meaning, never a journal. */
  commands?(input: ApplyInput): Promise<EditorialCommand[]>;
  complete?(input: ApplyInput, outcomes: readonly CommandOutcome[]): Promise<OwnerReceipt>;
  /** Owner redaction applies to every public representation of retained bytes. */
  disclose?(revision: ProposalRevision): Promise<ProposalRevision>;
  compensate(receipt: OwnerReceipt): Promise<ValidatedCandidate>;
  /** Receipt-only lookup; must not dispatch or require the old credential. */
  resolve?(input: ApplyInput): Promise<ApplyOutcome | { outcome: 'cancelled' } | null>;
}
export interface EditorialAdapterModule<Dependencies = unknown> {
  kind: string;
  create(dependencies: Dependencies): EditorialAdapter;
}

/** JSON only: undefined, non-finite numbers, class instances and cycles must not
 * disappear or change meaning while producing an exact candidate digest. */
export function canonicalCandidate(input: unknown, limits: { bytes: number; depth: number } = { bytes: EDITORIAL_COST.candidateBytes,
  depth: EDITORIAL_COST.jsonDepth }): { candidate: Json; digest: string } {
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): Json => {
    if (depth > limits.depth) throw new EditorialInvalid('Candidate nesting exceeds its bound');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new EditorialInvalid('Candidate must be JSON');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new EditorialInvalid('Candidate must be plain JSON');
    }
    ancestors.add(value);
    let result: Json;
    if (Array.isArray(value)) {
      result = Array.from(value, item => visit(item, depth + 1));
    } else {
      result = Object.fromEntries(Object.keys(value).sort().map(key =>
        [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    }
    ancestors.delete(value);
    return result;
  };
  const candidate = visit(input, 0), serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized) > limits.bytes) {
    throw new EditorialInvalid('Editorial JSON exceeds its byte bound');
  }
  return { candidate, digest: createHash('sha256').update(serialized).digest('hex') };
}
export function checkedHeads(heads: readonly BaseHead[]): BaseHead[] {
  if (!heads.length || heads.length > EDITORIAL_COST.baseHeads
    || heads.some(row => !row || typeof row.component !== 'string' || !row.component.length
      || row.component.length > 512 || row.head !== null
        && (typeof row.head !== 'string' || !row.head.length || row.head.length > 512))
    || new Set(heads.map(row => row.component)).size !== heads.length) {
    throw new EditorialInvalid('Expected component heads are invalid');
  }
  return heads.map(row => ({ component: row.component, head: row.head }))
    .sort((a, b) => a.component < b.component ? -1 : a.component > b.component ? 1 : 0);
}
export function headsEqual(left: readonly BaseHead[], right: readonly BaseHead[]): boolean {
  return JSON.stringify(checkedHeads(left)) === JSON.stringify(checkedHeads(right));
}
export function revisionOperationKey(proposal: string, revision: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proposal)
    || !Number.isSafeInteger(revision) || revision < 1) throw new EditorialInvalid('Invalid proposal revision');
  return `editorial:${proposal}:${revision}`;
}

export function makeProposalRevision(proposal: string, n: number, validated: ValidatedCandidate,
  evidence: readonly EvidenceRef[]): ProposalRevision {
  revisionOperationKey(proposal, n);
  if (evidence.length > EDITORIAL_COST.evidenceRefs || evidence.some(row => !row
    || [row.resource, row.revision].some(value => typeof value !== 'string' || !value.length || value.length > 512)
    || row.locator !== null && (typeof row.locator !== 'string' || row.locator.length > 4000))) {
    throw new EditorialInvalid('Evidence references exceed their bounds');
  }
  const { candidate, digest } = canonicalCandidate(validated.candidate);
  return { proposal, n, candidate, candidateDigest: digest,
    before: canonicalCandidate(validated.before).candidate, baseHeads: checkedHeads(validated.baseHeads),
    ...(validated.ownerCommand ? { ownerCommand: validated.ownerCommand } : {}),
    evidence: evidence.map(row => ({ resource: row.resource, revision: row.revision, locator: row.locator })) };
}
