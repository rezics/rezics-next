import { createHash } from 'node:crypto';
import type { Release } from '@rezics/definitions';
import type { Source } from '@rezics/definitions/bulk';
import { AccessWorkUnavailableError, EMPTY_ACCESS_WORK } from '../access/work.ts';
import { accessCheck } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { readFences } from '../content/source-fences.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { sourceTuple } from './fences.ts';
import { statementSlotId } from './item.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import {
  normalizeSourceStatement,
  LeafNativeWork,
  LeafReservationUnavailable,
  sourceBytes,
  sourceObject,
  selectedRank,
} from './scope-leaf-selection.ts';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { FactClause } from '../search/disclosure/check.ts';
import type { IndexedStatement } from '../search/source.ts';
import { admitScopeWork, type ScopeWorkContext } from '../search/scope-work-context.ts';

// The dedicated Kind producer retains its own closed native boundary. The
// generic actorless leaf path below does not acquire Type/audience authority.
export { createNativeKindTypeEvidence } from './kind-type-evidence.ts';
export type {
  NativeKindTypeEvidence,
  KindTypeEvidenceReference,
  KindTypeEvidenceProgress,
  KindTypeEvidenceAudienceInput,
  KindTypeEvidenceReadInput,
  KindTypeEvidenceReadResult,
  KindTypeEvidenceVerifyInput,
  KindTypeEvidenceVerifyResult,
} from './kind-type-evidence.ts';

export type LeafWork = Readonly<{
  keys: number;
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
}>;

export type LeafProgress = Readonly<{
  basis: string;
  phase: 'compact' | 'selection' | 'witness';
  valueOrdinal: number;
  after: string | null;
}>;

export type SelectedLeafFact = Readonly<{
  witness: string;
  statement: IndexedStatement;
  release: string;
  revision: number;
  rank: 'normal' | 'preferred';
}>;

export type LeafCoverage = { kind: 'selection'; basis: string } | { kind: 'empty_pair'; basis: string };

export type LeafEvidence =
  | { state: 'basis_changed' | 'not_ready'; usage: LeafWork }
  | {
      state: 'current';
      basis: string;
      type: string | null;
      facts: readonly SelectedLeafFact[];
      coverage: LeafCoverage | null;
      progress: LeafProgress | null;
      usage: LeafWork;
    };

export type LeafRequest = Readonly<{
  subject: string;
  leaf: FactClause;
  after: LeafProgress | null;
  /** One opaque witness identity for revalidation, not a receipt or permission; exclusive with `after`. */
  revalidate: string | null;
  budget: LeafWork;
}>;

type LeafWorkContext<W extends ScopeWorkContext = ScopeWorkContext> = W extends ScopeWorkContext
  ? Readonly<{ actor?: never; nativeT?: never; work: W }>
  : never;

export type LeafOptions = Readonly<{
  access: Access;
  routeKey: Uint8Array;
  deadline: number;
}> &
  (Readonly<{ actor: Actor; nativeT?: AuthoritativeTime; work?: never }> | LeafWorkContext);

export type LeafReader = (pool: Pool, request: LeafRequest, options: LeafOptions) => Promise<LeafEvidence>;

const workAxes = ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const;

function validateBudget(budget: LeafWork): void {
  if (!budget || typeof budget !== 'object') throw new RangeError('Invalid leaf work budget');

  for (const axis of workAxes) {
    const value = budget[axis];
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid leaf work budget');
  }

  if (budget.keys > 101 || budget.witnesses > 100) throw new RangeError('Invalid leaf work budget');
}

function validateRevalidation(request: LeafRequest): void {
  const witness = request.revalidate;
  if (witness === null) return;

  if (
    request.after !== null ||
    typeof witness !== 'string' ||
    witness.length === 0 ||
    witness.length > 128 ||
    /[^\x00-\x7f]/.test(witness)
  )
    throw new RangeError('Invalid leaf revalidation');
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class LeafNotReady extends Error {}
class LeafBasisChanged extends Error {}
type CurrentEvidence = Omit<Extract<LeafEvidence, { state: 'current' }>, 'usage'>;
type NativeAnchor = NonNullable<Awaited<ReturnType<LeafNativeWork['anchor']>>>;
type NativeCandidate = NonNullable<Awaited<ReturnType<LeafNativeWork['candidate']>>>;
const basisOf = (anchor: NativeAnchor, request: LeafRequest): string =>
  createHash('sha256')
    .update(JSON.stringify([request.subject, anchor, request.leaf]))
    .digest('hex');

function validateProgress(request: LeafRequest): void {
  const progress = request.after;
  if (progress === null) return;
  if (
    !/^[a-f0-9]{64}$/.test(progress.basis) ||
    !['compact', 'selection', 'witness'].includes(progress.phase) ||
    !Number.isSafeInteger(progress.valueOrdinal) ||
    progress.valueOrdinal < 0 ||
    (progress.after !== null &&
      (progress.phase === 'witness'
        ? !uuid.test(progress.after)
        : !/^(0|[1-9][0-9]*)$/.test(progress.after) || BigInt(progress.after) > (1n << 64n) - 2n))
  )
    throw new RangeError('Invalid leaf progress');
  const count = request.leaf.facet === 'statement' && 'values' in request.leaf ? new Set(request.leaf.values).size : 1;
  if (progress.valueOrdinal >= count) throw new RangeError('Invalid leaf progress value ordinal');
}

/** Same public floor and viewer-current Access formula for source and referenced targets.
 * Preparation completes before checkout. No ambient statement reader grants facts.
 */
async function prepareLeafAccess(pool: Pool, subject: string, options: LeafOptions, work: LeafNativeWork) {
  if (options.work)
    return work.accounting.unavailable('Commerce Members preparation work-definition/native work producer');
  const route = routeOf(subject);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  return accessCheck(
    options.access,
    options.actor,
    'subject:read',
    {
      route,
      id: subject,
      eligibility: subjectReadEligibility({ route, id: subject }),
    },
    {
      pool,
      deadline: options.deadline,
      ...(options.nativeT === undefined ? {} : { time: options.nativeT }),
      work: work.accounting,
    },
  );
}
function liveAnchor(anchor: NativeAnchor | null): anchor is NativeAnchor {
  return (
    !!anchor &&
    anchor.visibility === 'visible' &&
    anchor.redirect === null &&
    anchor.type !== null &&
    anchor.revision !== null
  );
}

async function currentTarget(
  pool: Pool,
  target: string,
  options: LeafOptions,
  work: LeafNativeWork,
): Promise<NativeAnchor | null> {
  const route = routeOf(target);
  if (route === null) return null;
  const check = await prepareLeafAccess(pool, target, options, work);
  return work.snapshot(pool, route, async (client) => {
    const anchor = await work.anchor(client, route, target);
    return liveAnchor(anchor) && (await check(client, options.nativeT)) ? anchor : null;
  });
}

/** Foreign observations are made after releasing the source, including pool.max=1.
 * Only immutable release bodies are retained within this invocation, never allow.
 */
async function publicCandidate(
  pool: Pool,
  row: NativeCandidate,
  property: string,
  rank: 'normal' | 'preferred',
  witness: string,
  options: LeafOptions,
  work: LeafNativeWork,
  releases: Map<string, Release['properties']>,
): Promise<SelectedLeafFact | null> {
  if (!row.body || row.release === null || row.revision === null || row.property !== property) throw new LeafNotReady();
  if (row.source_bytes > 0 && row.source === null) throw new LeafNotReady();
  if (row.source !== null) {
    if (
      !sourceObject(row.source) ||
      typeof row.source.source !== 'string' ||
      typeof row.source.external_id !== 'string' ||
      row.source.field_group !== 'facts'
    )
      throw new LeafNotReady();
    const tuple = sourceTuple(options.routeKey, row.source as Source);
    const fences = await work.snapshot(pool, tuple.route, (client) => {
      const inputBytes = sourceBytes([tuple]);
      const bound = { ...EMPTY_ACCESS_WORK, keys: 1, points: 1, rows: 3, bytes: 2 * inputBytes + 512, emptySeeks: 1 };
      return work.accounting.run(
        'Content source-fence native point',
        bound,
        () => readFences(client, [tuple]),
        (result) => ({
          ...bound,
          bytes: inputBytes + sourceBytes(result),
          emptySeeks: result[0]?.securityRevision === null ? 1 : 0,
        }),
      );
    });
    if (fences[0]?.takenDown !== false) return null;
  }
  let properties = releases.get(row.release) ?? {};
  const names = [property];
  if (sourceObject(row.body) && Array.isArray(row.body.qualifiers))
    for (const raw of row.body.qualifiers)
      if (sourceObject(raw) && typeof raw.property === 'string') names.push(raw.property);
  const missing = names.filter((name) => !Object.hasOwn(properties, name));
  if (missing.length) {
    properties = { ...properties, ...(await work.release(pool, row.release, missing)) };
    releases.set(row.release, properties);
  }
  const normalized = normalizeSourceStatement(property, row.body, properties);
  if (!normalized) return null;
  const targets = new Set<string>();
  if (normalized.facet?.kind === 'item') targets.add(normalized.value);
  for (const qualifier of normalized.qualifiers ?? [])
    if (properties[qualifier.property]?.datatype === 'wikibase-item') targets.add(qualifier.value);
  if (normalized.facet?.kind === 'quantity' && routeOf(normalized.facet.unit) !== null)
    targets.add(normalized.facet.unit);
  // Every target, including discarded qualifiers, is reserved before preparation.
  // No cross-home connection or cached permission survives this stage.
  for (const target of targets) if (!(await currentTarget(pool, target, options, work))) return null;
  return { witness, statement: normalized, release: row.release, revision: row.revision, rank };
}

async function readNativeLeaf(
  pool: Pool,
  request: LeafRequest,
  options: LeafOptions,
  work: LeafNativeWork,
): Promise<CurrentEvidence> {
  const route = routeOf(request.subject);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  const check = await prepareLeafAccess(pool, request.subject, options, work);
  const initial = await work.snapshot(pool, route, async (client) => {
    const anchor = await work.anchor(client, route, request.subject);
    if (!liveAnchor(anchor) || !(await check(client, options.nativeT))) throw new LeafNotReady();
    return anchor;
  });
  const basis = basisOf(initial, request);
  if (request.after !== null && request.after.basis !== basis) throw new LeafBasisChanged();
  const evidence: CurrentEvidence = { state: 'current', basis, type: null, facts: [], coverage: null, progress: null };
  if (request.leaf.facet === 'type') {
    evidence.type = initial.type;
    evidence.coverage = { kind: 'selection', basis };
    return evidence;
  }
  const leaf = request.leaf;
  const releases = new Map<string, Release['properties']>();
  const release = await work.release(pool, initial.current_release, [leaf.property]);
  releases.set(initial.current_release, release);
  const definition = release[leaf.property];
  if (!definition) throw new LeafNotReady();
  const relation = definition.relation !== undefined;
  if (relation && !('values' in leaf))
    return work.accounting.unavailable('Semantic native relation range selective access path');
  const values = 'values' in leaf ? [...new Set(leaf.values)].sort() : [];
  const slotId = statementSlotId(request.subject, leaf.property);
  const pending = new Map<string, { row: NativeCandidate; rank: 'normal' | 'preferred'; witness: string }>();
  let complete = false;
  // A fresh exact pair observation can prove absence from both complete native
  // domains. Any raw row returns immediately as partial evidence; only a fresh
  // invocation that gets an empty seek from every domain/value may certify empty.
  let relationEmptyPairProven = false;
  const continueAt = (next: LeafProgress, start: LeafProgress) => {
    const previous = request.after ?? start;
    if (next.phase === previous.phase && next.valueOrdinal === previous.valueOrdinal && next.after === previous.after)
      throw new LeafNotReady();
    evidence.progress = next;
  };
  await work.snapshot(pool, route, async (client) => {
    const anchor = await work.anchor(client, route, request.subject);
    if (!liveAnchor(anchor) || basisOf(anchor, request) !== basis) throw new LeafBasisChanged();

    const extract = async (witness: string, id: string) => {
      const state = await work.slot(client, route, request.subject, id);
      let rank: 'normal' | 'preferred' | null = null;
      if (state.operation === 'expand') {
        const selection = await work.membership(client, route, request.subject, id, witness);
        if (!selection) return;
        rank = selection.rank;
      }
      if (await work.concealed(client, route, request.subject, witness)) return;
      // Length guards apply before driver transfer. Leave room for final native revalidation.
      const maxBytes = Math.max(0, work.remaining('bytes') - 8192);
      const row = await work.candidate(client, route, request.subject, witness, maxBytes);
      if (row && (row.body === null || row.property === null || (row.source_bytes > 0 && row.source === null)))
        throw new LeafNotReady();
      if (!row || row.property !== leaf.property || row.slot_id !== id) return;
      if (state.operation !== 'expand') {
        if (row.expanded || row.operation !== 'assert') return;
        rank = sourceObject(row.body) ? selectedRank(row.body.rank) : null;
      }
      if (!rank) return;
      if (row.body === null || (row.source_bytes > 0 && row.source === null)) throw new LeafNotReady();
      pending.set(witness, { row, rank, witness });
    };

    if (request.revalidate !== null) {
      if (!uuid.test(request.revalidate)) return;
      const id = await work.locator(client, route, request.subject, request.revalidate);
      if (id) await extract(request.revalidate, id);
      // A remembered witness never establishes complete negative coverage.
      return;
    }
    if (!relation) {
      const state = await work.slot(client, route, request.subject, slotId);
      if (state.operation === 'expand') {
        if (request.after && request.after.phase !== 'selection') throw new LeafBasisChanged();
        let ordinal = request.after?.after === null || request.after === null ? 0 : Number(request.after.after) + 1;
        if (!Number.isSafeInteger(ordinal)) throw new RangeError('Invalid selected ordinal');
        const count = state.selected ?? 0;
        while (ordinal < count) {
          // Hold room for final source checks and refuse the next whole unit
          // before consuming its key. There is no per-slot extra key allowance.
          if (work.remaining('keys') < 7 || work.remaining('witnesses') < 1) {
            continueAt(
              { basis, phase: 'selection', valueOrdinal: 0, after: ordinal === 0 ? null : String(ordinal - 1) },
              { basis, phase: 'selection', valueOrdinal: 0, after: null },
            );
            return;
          }
          const selected = await work.selected(client, route, request.subject, slotId, ordinal);
          if (selected) await extract(selected.candidate, slotId);
          ordinal++;
        }
        complete = request.after === null;
      } else {
        if (request.after && request.after.phase !== 'compact') throw new LeafBasisChanged();
        let after = request.after?.after ?? null;
        while (state.log_seq !== null && (after === null || BigInt(after) < BigInt(state.log_seq))) {
          if (work.remaining('keys') < 6 || work.remaining('witnesses') < 1) {
            continueAt(
              { basis, phase: 'compact', valueOrdinal: 0, after },
              { basis, phase: 'compact', valueOrdinal: 0, after: null },
            );
            return;
          }
          const raw = await work.compact(client, route, request.subject, slotId, after);
          if (!raw) throw new LeafBasisChanged();
          if (raw.candidate_id) await extract(raw.candidate_id, slotId);
          after = raw.after;
        }
        complete = request.after === null;
      }
      return;
    }
    // Exactly one raw possible witness is consumed per bounded step. The next
    // call seeks strictly after it, including rejected/duplicate native rows.
    let ordinal = request.after?.valueOrdinal ?? 0;
    let phase: 'compact' | 'witness' = request.after?.phase === 'witness' ? 'witness' : 'compact';
    if (request.after?.phase === 'selection') throw new LeafBasisChanged();
    let after = request.after?.after ?? null;
    while (ordinal < values.length) {
      if (work.remaining('keys') < 7 || work.remaining('witnesses') < 2) {
        continueAt(
          { basis, phase, valueOrdinal: ordinal, after },
          { basis, phase: 'compact', valueOrdinal: 0, after: null },
        );
        return;
      }
      const raw = await work.pair(client, route, request.subject, leaf.property, values[ordinal]!, phase, after);
      if (raw) {
        if (raw.candidate_id) await extract(raw.candidate_id, raw.slot_id);
        evidence.progress = { basis, phase, valueOrdinal: ordinal, after: raw.after };
        return;
      }
      if (phase === 'compact') {
        phase = 'witness';
        after = null;
      } else {
        ordinal++;
        phase = 'compact';
        after = null;
      }
    }
    // Both SQL ranges enumerate the complete current-source possible-pair
    // superset (compact assertions and all native candidates). A resumed suffix
    // cannot establish the omitted prefix, even when its own seeks are empty.
    relationEmptyPairProven = request.after === null && request.revalidate === null;
  });
  const facts: SelectedLeafFact[] = [];
  for (const chosen of pending.values()) {
    const fact = await publicCandidate(
      pool,
      chosen.row,
      leaf.property,
      chosen.rank,
      chosen.witness,
      options,
      work,
      releases,
    );
    if (fact) facts.push(fact);
    else if (request.after && !relation && chosen.row.source !== null) throw new LeafBasisChanged();
  }
  evidence.facts = facts;
  // Source changes during independent foreign reads invalidate the whole observation.
  await work.snapshot(pool, route, async (client) => {
    const anchor = await work.anchor(client, route, request.subject);
    if (!liveAnchor(anchor)) throw new LeafNotReady();
    if (basisOf(anchor, request) !== basis) throw new LeafBasisChanged();
    if (!(await check(client, options.nativeT))) throw new LeafNotReady();
  });
  if (relationEmptyPairProven) evidence.coverage = { kind: 'empty_pair', basis };
  if (complete) evidence.coverage = { kind: 'selection', basis };
  return evidence;
}

/** Native selected evidence only; matching remains the shared Search pure matcher. */
export async function readScopeLeafEvidence(
  pool: Pool,
  request: LeafRequest,
  options: LeafOptions,
): Promise<LeafEvidence> {
  validateBudget(request?.budget);
  validateRevalidation(request);
  validateProgress(request);
  const work = new LeafNativeWork(request.budget, options.deadline);
  // Work admission has no receipt-producing native adapter in its owning module.
  // Refuse BEFORE IO rather than borrowing a request Actor or hiding owner IO.
  if (options.work) {
    await admitScopeWork(options.work, { pool, access: options.access, deadline: options.deadline });
    work.accounting.unavailable('Library scoped native leaf work producer');
  }
  const result = await work.accounting.capture(() =>
    withPublicStatementReader(() =>
      withRequestDeadline(options.deadline, () => readNativeLeaf(pool, request, options, work)),
    ),
  );
  if (result.state === 'complete') return { ...result.value, usage: result.usage };
  if (result.state === 'unavailable') throw new (AccessWorkUnavailableError())(result.dependency);
  if (result.error instanceof LeafBasisChanged) return { state: 'basis_changed', usage: result.usage };
  if (result.error instanceof LeafNotReady || result.error instanceof LeafReservationUnavailable)
    return { state: 'not_ready', usage: result.usage };
  throw result.error;
}
