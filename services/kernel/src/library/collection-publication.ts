/** One explicit selection, admitted by the existing Source and owner-filter engines. */
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { shareAccount } from '../access/account-share.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessCheck, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';
import {
  authorizeCollectionRule,
  prepareCollectionRuleAuthority,
  readSavedCollectionRule,
  type SavedCollectionRule,
} from './collection-rules.ts';
import { readCollection } from './collection-store.ts';
import { captureCollectionMetadataHistory } from './collection-metadata-history.ts';
import { createCollectionSource, type CollectionSourceObservation, type WorkDimensions } from './collection-source.ts';
import {
  appendCollectionSourceOutput,
  beginCollectionSourceOutput,
  completeCollectionSourceOutput,
} from './collection-source-output.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { revalidateNativeOwnerFilter, withNativeOwnerFilterSource } from './owner-filter-native-binding.ts';
import { admitCollectionMemberQuery } from './owner-filter.ts';
import {
  bindOwnerFilterRead,
  readOwnerFilterCandidate,
  readOwnerFilterCandidateClosure,
  type OwnerFilterReadBinding,
} from './owner-filter-plan.ts';
import { resolveSubject, SubjectIdentityUnavailableError } from './subject-anchor.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
export type CollectionPublicationInput = Readonly<{ revision: number; subjectIds: readonly string[] }>;
export type CollectionPublication = Readonly<{ generation: string; state: 'complete'; itemCount: number }>;
type Client = Pick<PoolClient, 'query'>;
type Header = Readonly<{
  revision: number;
  sourceGeneration: string;
  visibility: 'private' | 'unlisted' | 'public';
  createdAt: string;
}>;
const unavailable = () => new ProblemError('dependency_unavailable');
const conflict = () => new ProblemError('conflict');
const zero: WorkDimensions = {
  candidateKeys: 0,
  identityMetadataRows: 0,
  nativeRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
};

/** Raw uniqueness is checked before identity normalization. Empty is an explicit intent. */
export function collectionPublicationInput(input: CollectionPublicationInput): CollectionPublicationInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'revision' && key !== 'subjectIds') ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !Array.isArray(input.subjectIds) ||
    input.subjectIds.length > 100 ||
    input.subjectIds.some((id) => typeof id !== 'string' || routeOf(id) === null || id !== id.toLowerCase()) ||
    new Set(input.subjectIds).size !== input.subjectIds.length
  )
    throw new ProblemError('invalid_request');
  return { revision: input.revision, subjectIds: Object.freeze([...input.subjectIds]) };
}

/** The same-owner predicate precedes all private definition reads, including before receipt replay. */
async function header(client: Client, route: number, collectionId: string, owner: string, lock = false) {
  return (
    (
      await client.query<Header>(
        `SELECT revision, source_generation::text AS "sourceGeneration", visibility, created_at::text AS "createdAt"
     FROM library.collection
     WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3 AND state='active'
       AND membership_kind='dynamic' AND builtin_kind IS NULL AND rule_filter IS NOT NULL
       AND rule_sort IS NOT NULL AND rule_release_digest IS NOT NULL${lock ? ' FOR UPDATE' : ''}`,
        [route, collectionId, owner],
      )
    ).rows[0] ?? null
  );
}

function sameSource(before: CollectionSourceObservation, after: CollectionSourceObservation) {
  return (
    before.collectionId === after.collectionId &&
    before.route === after.route &&
    before.incarnation === after.incarnation &&
    before.revision === after.revision &&
    before.basis.digest === after.basis.digest &&
    canonicalize(before.authority) === canonicalize(after.authority)
  );
}

/** Source-local revalidation uses the published tx port; it must never visit foreign homes under parent lock. */
async function currentScope(
  deps: Dependencies,
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
  tx?: CommandTransaction,
) {
  const result = await work.compose(async (allowance) => {
    const result = await createIdentityScopedObservations(deps.pool).revalidate({
      key: binding.scope.key,
      expected: binding.scope,
      deadline: binding.input.deadline,
      ...(tx ? { tx } : {}),
    });
    return {
      result,
      work: {
        reservationId: allowance.reservationId,
        used: {
          ...zero,
          nativeRows: result.work.rows,
          nativePoints: result.work.points,
          statements: result.work.statements,
          bytes: result.work.bytes,
        },
      },
    };
  });
  if (
    result.result.status !== 'current' ||
    result.result.observation.captureId !== binding.scope.captureId ||
    result.result.observation.committedRevision !== binding.scope.committedRevision
  )
    throw unavailable();
}

type Prepared = {
  header: Header;
  rule: SavedCollectionRule;
  checks: readonly AccessCheck[];
  binding: OwnerFilterReadBinding;
  work: NativeCollectionWork;
  output: ReturnType<NativeCollectionWork['reserve']>;
  subjectIds: readonly string[];
};

/** Native preparation releases the parent before Source, identity, disclosure and private fact homes.
 * The actual admitted owner binding selects private working capture, including after output A activates.
 * Missing capture is unavailability even for [], never proof of an empty Source or a successful publication.
 */
async function prepareSelection(
  deps: Dependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  route: number,
  collectionId: string,
  raw: readonly string[],
  attempt: CommandAttempt,
  deadline: number,
): Promise<Prepared> {
  const saved = await withConnection(deps.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const current = await header(client, route, collectionId, actor.accountId);
      if (!current) throw new ProblemError('not_found');
      const rule = await readSavedCollectionRule(client, route, collectionId);
      if (!rule || rule.collectionRevision !== current.revision || rule.sourceGeneration !== current.sourceGeneration)
        throw unavailable();
      await client.query('COMMIT');
      return { header: current, rule };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  const admission = await admitCollectionMemberQuery(
    deps,
    actor,
    {
      filter: JSON.stringify(saved.rule.filter),
      sort: saved.rule.sort,
    },
    deadline,
  );
  if (!admission.filter || admission.releaseDigest !== saved.rule.releaseDigest) throw unavailable();
  const checks = await prepareCollectionRuleAuthority(deps, actor, admission.filter, attempt, deadline);
  const bound = await bindOwnerFilterRead(deps, actor, collectionId, admission, deadline, attempt);
  if (bound.status !== 'bound') throw unavailable();
  const binding = bound.binding;
  const sourceKey = binding.scope.key.source;
  if (
    binding.input.actor !== actor ||
    binding.input.at !== attempt.time ||
    binding.input.collectionId !== collectionId ||
    binding.input.deadline > deadline ||
    sourceKey.kind !== 'library' ||
    sourceKey.identity.scope === 'public_output' ||
    sourceKey.identity.collectionId !== collectionId ||
    sourceKey.identity.route !== route ||
    sourceKey.identity.accountId !== actor.accountId ||
    sourceKey.identity.generation !== saved.header.sourceGeneration
  )
    throw unavailable();
  const workingIdentity = sourceKey.identity;
  const work = new NativeCollectionWork(binding.input.allowance, deadline);
  return withNativeOwnerFilterSource(binding, work, async () => {
    // One transferred reservation, never another raw100 allowance. Hold the entire known output work
    // before verification: parent CAS, <=100 children, checkpoints, two retained headers and ordinary event/receipt.
    // Conservative plan-work charges are not a claim of measured native/whole-command physical proof.
    const output = work.reserve({
      ...zero,
      candidateKeys: raw.length,
      nativeRows: 2048 + raw.length * 32,
      nativePoints: 128 + raw.length * 8,
      statements: 64,
      bytes: 65536 + raw.length * 512,
      emptySeeks: 32,
    });
    const source = createCollectionSource(deps);
    const prepared = await work.compose((allowance) => source.prepare({ ...binding.input, allowance }));
    if (
      prepared.source.observation.collectionId !== collectionId ||
      prepared.source.observation.route !== route ||
      prepared.source.observation.revision !== saved.header.revision ||
      prepared.source.observation.incarnation !== workingIdentity.incarnation ||
      prepared.source.observation.authority.kind !== 'private_builtin' ||
      prepared.source.observation.authority.curatorAccountId !== actor.accountId
    )
      throw unavailable();
    await currentScope(deps, binding, work);
    async function resolveCurrent(originalId: string) {
      // Raw selections AND every complete-original fact reference pay original/terminal disclosure.
      // Source membership may return after one positive alias; it does not authorize the remaining closure.
      const disclosure = work.reserve({
        ...zero,
        candidateKeys: 1,
        nativeRows: 8192,
        nativePoints: 128,
        statements: 128,
        bytes: 1024 * 1024,
      });
      disclosure.dispatch();
      let resolved;
      try {
        resolved = await resolveSubject(
          deps,
          actor,
          originalId,
          attempt.time,
          commandAccessContext({ pool: deps.pool, deadline }, attempt),
        );
      } finally {
        disclosure.settle();
      }
      if (!resolved) throw new ProblemError('not_found');
      return resolved;
    }
    const verified: string[] = [];
    for (const originalId of raw) {
      const resolved = await resolveCurrent(originalId);
      const membership = await work.compose((allowance) =>
        source.containsSubject({
          ...binding.input,
          source: prepared.source,
          allowance,
          subjectId: resolved.subjectId,
        }),
      );
      if (!sameSource(prepared.source.observation, membership.observation) || membership.result === 'not_proven')
        throw unavailable();
      if (!membership.result) throw new ProblemError('not_found');
      const closure = await readOwnerFilterCandidateClosure(binding, prepared.source, resolved.subjectId, work);
      if (closure.status !== 'complete') throw unavailable();
      if (closure.closure.subjectId !== resolved.subjectId) throw unavailable();
      // A canonical positive obtained from another alias cannot silently authorize an unobserved raw reference.
      if (!closure.closure.originals.some((original) => original.subjectId === originalId)) throw unavailable();
      for (const original of closure.closure.originals) {
        const current = await resolveCurrent(original.subjectId);
        if (current.subjectId !== resolved.subjectId) throw unavailable();
      }
      const snapshot = work.reserve({ ...zero, nativePoints: 1, statements: 3, bytes: 256 });
      snapshot.dispatch();
      let match;
      try {
        match = await withConnection(deps.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const result = await readOwnerFilterCandidate(client, admission, closure.closure, work);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
      } finally {
        snapshot.settle();
      }
      if (match === 'not_proven') throw unavailable();
      if (!match) throw new ProblemError('not_found');
      verified.push(resolved.subjectId);
    }
    const final = await work.compose((allowance) => source.prepare({ ...binding.input, allowance }));
    if (!sameSource(prepared.source.observation, final.source.observation)) throw conflict();
    await revalidateNativeOwnerFilter(binding, work);
    await currentScope(deps, binding, work);
    return { ...saved, checks, binding, work, output, subjectIds: [...new Set(verified)].sort() };
  });
}

export function createCollectionPublications(deps: Dependencies) {
  return {
    async publishSelected(actor: Actor, collectionId: string, value: CollectionPublicationInput, key: string) {
      const input = collectionPublicationInput(value);
      const route = routeOf(collectionId);
      if (actor.kind !== 'account' || route === null || route !== routeOf(actor.accountId))
        throw new ProblemError('not_found');
      const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
      const native = resourceAuthorization({
        access: deps.access,
        actor,
        action: 'collection:update',
        anchor: {
          resource: { route, id: collectionId },
          async validate(client) {
            return !!(await header(client, route, collectionId, actor.accountId));
          },
        },
        context: { pool: deps.pool, deadline, partition: partitionOf(route) },
      });
      const attempts = new WeakMap<AuthoritativeTime, Prepared>();
      const identity = principalCommandIdentity(actor);
      const kind = 'library.collection.publish-selected';
      const generation = randomUUID();
      return runCommand(
        deps.pool,
        {
          ...identity,
          partition: partitionOf(route),
          deadline,
          clock: deps.clock,
          receipt: {
            kind,
            key,
            digest: createHash('sha256')
              .update(canonicalize([identity, kind, collectionId, input])!)
              .digest(),
          },
          authorization: {
            ...native,
            async prepare(attempt) {
              const proof = await native.prepare!(attempt);
              attempts.set(
                attempt.time,
                await prepareSelection(deps, actor, route, collectionId, input.subjectIds, attempt, deadline),
              );
              return proof;
            },
            async authorize(tx, attempt, proof) {
              if ((await native.authorize(tx, attempt, proof)) !== 'execute') throw new GrantDeniedError();
              try {
                await shareAccount(tx, actor.accountId);
              } catch (error) {
                if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
                throw error;
              }
              const prepared = attempts.get(attempt.time);
              if (!prepared) throw unavailable();
              const compare = prepared.work.reserve({
                ...zero,
                nativeRows: 64,
                nativePoints: 8,
                statements: 2,
                bytes: 65536,
                emptySeeks: 2,
              });
              compare.dispatch();
              try {
                const current = await header(tx, route, collectionId, actor.accountId, true);
                if (!current) throw new ProblemError('not_found');
                if (canonicalize(current) !== canonicalize(prepared.header)) throw conflict();
                const rule = await readSavedCollectionRule(tx, route, collectionId);
                if (canonicalize(rule) !== canonicalize(prepared.rule)) throw conflict();
              } finally {
                compare.settle();
              }
              await authorizeCollectionRule(tx, attempt, prepared.checks);
              await currentScope(deps, prepared.binding, prepared.work, tx);
              // All of the above precedes Core receipt lookup, on replays as well as first execution.
              return 'execute';
            },
          },
        },
        async (tx, command) => {
          const prepared = attempts.get(command.time);
          if (!prepared) throw unavailable();
          if (prepared.header.revision !== input.revision) throw conflict();
          prepared.output.dispatch();
          try {
            // The route itself is explicit public metadata consent. Transition and output activation share
            // one native transaction. Do not advance the source fence until COMPLETE selects this output.
            const before = await readCollection(tx, route, collectionId);
            if (!before || before.revision !== input.revision || before.curatorAccountId !== actor.accountId)
              throw conflict();
            const changed = await tx.query(
              `UPDATE library.collection SET visibility='public', revision=revision+1,
               updated_at=$4::timestamptz, transaction_id=$5
             WHERE route=$1 AND collection_id=$2 AND revision=$3 AND source_generation=$6
               AND state='active' AND curator_account_id=$7`,
              [
                route,
                collectionId,
                input.revision,
                authoritativeTimeValue(command.time),
                command.transactionId,
                prepared.header.sourceGeneration,
                actor.accountId,
              ],
            );
            if (changed.rowCount !== 1) throw conflict();
            const ref = { route, collectionId, generation };
            await beginCollectionSourceOutput(tx, { ...ref, expectedMembers: prepared.subjectIds.length });
            if (prepared.subjectIds.length)
              await appendCollectionSourceOutput(tx, { ...ref, after: null, subjectIds: prepared.subjectIds });
            await completeCollectionSourceOutput(tx, ref);
            const collection = await readCollection(tx, route, collectionId);
            if (!collection) throw conflict();
            await captureCollectionMetadataHistory(tx, {
              route,
              before,
              after: collection,
              transactionId: command.transactionId,
              time: authoritativeTimeValue(command.time),
            });
            return {
              value: {
                collection,
                publication: { generation, state: 'complete' as const, itemCount: prepared.subjectIds.length },
              },
              events: [
                { type: 'com.rezics.library.collection.updated.v1', subject: collectionId, data: { collectionId } },
                {
                  type: 'com.rezics.library.collection.listing.changed.v1',
                  subject: collectionId,
                  data: { collectionId },
                },
              ],
            };
          } finally {
            prepared.output.settle();
          }
        },
      ).catch((error: unknown) => {
        if (error instanceof SubjectIdentityUnavailableError) throw unavailable();
        throw error;
      });
    },
  };
}
