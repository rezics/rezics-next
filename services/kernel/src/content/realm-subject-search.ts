import { createHash } from 'node:crypto';
import { AccessUnavailableError } from '../request/unavailable.ts';
import { AccessWorkAccounting, type AccessWork, type AccessWorkSink } from '../work/access-work.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { ScopeWork, zeroScopeWork } from '../search/scope-execution.ts';
import type {
  RealmSubjectDisclosureContext,
  RealmSubjectDisclosureDependencies,
  RealmSubjectParentObservation,
} from './realm-subject-disclosure.ts';
import {
  observeRealmSubjectParent,
  observeRealmSubjectSubject,
  prepareRealmSubjectDisclosure,
  sameCurrentRealmSubjectParent,
} from './realm-subject-disclosure.ts';
import { createRealmSubjectLifecycle } from './realm-subject-lifecycle.ts';
import {
  createRealmSubjectSource,
  type RealmSubjectDisclosure,
  type RealmSubjectSource,
} from './realm-subject-source.ts';
import { ContentNotFoundError } from './reads.ts';

function accessDimensions(value: AccessWork): WorkDimensions {
  return {
    candidateKeys: value.keys,
    nativeRows: value.rows,
    identityMetadataRows: 0,
    emptySeeks: value.emptySeeks,
    nativePoints: value.points,
    witnessKeys: value.witnesses,
    statements: 0,
    bytes: value.bytes,
  };
}

function add(left: WorkDimensions, right: WorkDimensions): WorkDimensions {
  return {
    candidateKeys: left.candidateKeys + right.candidateKeys,
    nativeRows: left.nativeRows + right.nativeRows,
    identityMetadataRows: left.identityMetadataRows + right.identityMetadataRows,
    emptySeeks: left.emptySeeks + right.emptySeeks,
    nativePoints: left.nativePoints + right.nativePoints,
    witnessKeys: left.witnessKeys + right.witnessKeys,
    statements: left.statements + right.statements,
    bytes: left.bytes + right.bytes,
  };
}

function subtract(left: WorkDimensions, right: WorkDimensions): WorkDimensions {
  return {
    candidateKeys: left.candidateKeys - right.candidateKeys,
    nativeRows: left.nativeRows - right.nativeRows,
    identityMetadataRows: left.identityMetadataRows - right.identityMetadataRows,
    emptySeeks: left.emptySeeks - right.emptySeeks,
    nativePoints: left.nativePoints - right.nativePoints,
    witnessKeys: left.witnessKeys - right.witnessKeys,
    statements: left.statements - right.statements,
    bytes: left.bytes - right.bytes,
  };
}

function fits(value: WorkDimensions, limit: WorkDimensions): boolean {
  return Object.keys(value).every((axis) => {
    const key = axis as keyof WorkDimensions;
    return value[key] <= limit[key];
  });
}

function disclosureContext(reader: Extract<LeafOptions, { actor: unknown }>, work: AccessWorkAccounting) {
  return { actor: reader.actor, deadline: reader.deadline, work } satisfies RealmSubjectDisclosureContext;
}

/** Charge native Access reservations and receipts to the caller's existing Search root. */
async function withDisclosureWork<T>(
  reader: Extract<LeafOptions, { actor: unknown }>,
  scope: ScopeWork,
  maximum: WorkDimensions,
  run: (context: RealmSubjectDisclosureContext) => Promise<T>,
): Promise<T> {
  let reserved = zeroScopeWork();
  let settled = zeroScopeWork();
  const sink: AccessWorkSink = {
    reserve(_operation, bound) {
      const held = accessDimensions(bound);
      const reservation = { ...held, statements: 1 };
      const nextReserved = add(reserved, reservation);
      const total = add(settled, nextReserved);
      if (!fits(nextReserved, maximum) || !fits(total, scope.remaining().remaining)) return null;
      reserved = nextReserved;
      let open = true;
      return {
        settle(actual) {
          if (!open) return;
          open = false;
          reserved = subtract(reserved, reservation);
          settled = add(settled, { ...accessDimensions(actual), statements: 1 });
        },
      };
    },
  };
  const accounting = new AccessWorkAccounting(sink, reader.deadline);
  try {
    return await run(disclosureContext(reader, accounting));
  } finally {
    scope.consume(settled);
  }
}

function unavailableOrConcealed(error: unknown): 'unavailable' | 'concealed' | undefined {
  if (error instanceof AccessUnavailableError) return 'unavailable';
  if (error instanceof ContentNotFoundError || (error instanceof ProblemError && error.code === 'not_found'))
    return 'concealed';
  return undefined;
}

const pointBound = (values: Partial<WorkDimensions>): WorkDimensions => ({
  ...zeroScopeWork(),
  ...values,
});

const bounds = Object.freeze({
  resolve: pointBound({
    candidateKeys: 16,
    nativeRows: 512,
    emptySeeks: 16,
    nativePoints: 256,
    statements: 256,
    bytes: 512 * 1024,
  }),
  current: pointBound({
    candidateKeys: 16,
    nativeRows: 512,
    emptySeeks: 16,
    nativePoints: 256,
    statements: 256,
    bytes: 512 * 1024,
  }),
  subject: pointBound({
    candidateKeys: 8,
    nativeRows: 128,
    emptySeeks: 8,
    nativePoints: 64,
    statements: 64,
    bytes: 256 * 1024,
  }),
  candidate: pointBound({
    candidateKeys: 128,
    nativeRows: 4096,
    emptySeeks: 128,
    nativePoints: 1024,
    witnessKeys: 1024,
    statements: 1024,
    bytes: 1024 * 1024,
  }),
});

/**
 * Compose the finite Content Realm census, current disclosure and live lifecycle for one actual reader.
 * Search receives no native locator or copied authorization evidence from this adapter.
 */
export function createRealmSubjectSearchSource(input: {
  pool: Parameters<typeof createRealmSubjectSource>[0]['pool'];
  reader: LeafOptions;
}): RealmSubjectSource | undefined {
  if (!('actor' in input.reader) || input.reader.actor === undefined) return undefined;
  const reader = input.reader as Extract<LeafOptions, { actor: unknown }>;
  const dependencies: RealmSubjectDisclosureDependencies = { pool: input.pool, access: reader.access };
  const parents = new Map<string, { realm: string; observation: RealmSubjectParentObservation }>();
  let nextDependency = 0;
  const lifecycle = createRealmSubjectLifecycle({ pool: input.pool });

  const disclosure: RealmSubjectDisclosure = {
    bounds,
    async resolve(realm, context) {
      try {
        const result = await withDisclosureWork(reader, context.work, bounds.resolve, (native) =>
          observeRealmSubjectParent(dependencies, realm, native),
        );
        if (!result) return { state: 'concealed' };
        const dependency = createHash('sha256')
          .update(`${realm}:${result.signature}:${++nextDependency}`)
          .digest('base64url');
        parents.set(dependency, { realm, observation: result });
        return { state: 'ready', dependency };
      } catch (error) {
        const state = unavailableOrConcealed(error);
        if (state) return { state };
        throw error;
      }
    },
    async current(realm, dependency, context) {
      const retained = parents.get(dependency);
      if (!retained || retained.realm !== realm) return 'changed';
      try {
        const after = await withDisclosureWork(reader, context.work, bounds.current, (native) =>
          observeRealmSubjectParent(dependencies, realm, native),
        );
        if (!after) return 'concealed';
        return sameCurrentRealmSubjectParent(retained.observation, after) ? 'current' : 'changed';
      } catch (error) {
        const state = unavailableOrConcealed(error);
        if (state === 'concealed') return 'concealed';
        if (state === 'unavailable') return 'unavailable';
        throw error;
      }
    },
    async candidate(candidate, dependency, context) {
      const [result] = await this.candidates!([candidate], dependency, context);
      return result!;
    },
    async candidates(candidates, dependency, context) {
      const realm = parents.get(dependency);
      if (!realm || candidates.length < 1 || candidates.length > 8) return candidates.map(() => 'unknown');
      const prepared = await withDisclosureWork(reader, context.work, bounds.candidate, async (native) => {
        const exact = await prepareRealmSubjectDisclosure(
          dependencies,
          {
            realmId: realm.realm,
            candidates: candidates.map((candidate) => ({
              threadId: candidate.thread,
              openingPostId: candidate.opening,
              subjectId: candidate.terminal!,
            })),
          },
          native,
        );
        return exact.finish();
      });
      return prepared.map((result) =>
        result.state === 'positive' ? 'discussed' : result.state === 'absent' ? 'not_published' : result.state,
      );
    },
    async subject(subject, dependency, context) {
      if (!parents.has(dependency)) return { state: 'unknown' };
      try {
        const value = await withDisclosureWork(reader, context.work, bounds.subject, (native) =>
          observeRealmSubjectSubject(dependencies, subject, native),
        );
        return value ? { state: 'readable', terminal: subject } : { state: 'withheld' };
      } catch (error) {
        const state = unavailableOrConcealed(error);
        if (state) return { state: state === 'concealed' ? 'withheld' : 'unknown' };
        throw error;
      }
    },
  };

  return createRealmSubjectSource({ pool: input.pool, disclosure, maintenance: lifecycle.maintenance });
}
