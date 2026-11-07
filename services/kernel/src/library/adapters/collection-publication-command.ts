/** The one native begin command; process composition chooses this implementation. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { captureDurableInitiator, durableInitiatorCommitment } from '../../access/durable-initiator-capture.ts';
import type { DurableInitiatorRecord } from '../../access/durable-initiator.ts';
import { shareAccount } from '../../access/account-share.ts';
import { resourceAuthorization } from '../../access/index.ts';
import type { KernelClock } from '../../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  currentCommandReceipt,
  IdempotencyConflictError,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
} from '../../command/command.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { accessCheck } from '../../request/access-check.ts';
import { type Access, type AccessContext, type AccessClient, type AccountActor } from '../../request/access.ts';
import { deadlineFor } from '../../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../route/route.ts';
import { stageHistoryWork } from '../../work/history-enqueue.ts';
import { initializeCanonicalCollectionSource } from '../canonical-source-store.ts';
import { nativeSourceFence } from '../native-source-fence.ts';
import { prepareBuiltinMaterialization } from '../builtin-materialization.ts';
import { readCollection } from '../collection-store.ts';

import { readNativeCollectionWorkingMetadata } from '../collection-source-native.ts';
import {
  authorizeCollectionRule,
  prepareCollectionRuleAuthority,
  type SavedCollectionRule,
} from '../collection-rules.ts';
import { admitSavedCollectionMemberQuery, prepareNativeCollectionMemberAuthority } from '../owner-filter.ts';
import type {
  CollectionPublicationSource,
  CollectionPublicationRuleRef,
} from '../collection-publication-episode-contract.ts';
import type { CollectionPublicationLocator } from '../collection-publication-work-admission.ts';
import type { WorkAllowance } from '../contract/work-dimensions.ts';
import type { NativeSourceIdentity } from '../native-source-custody.ts';
import { commandHistoryIdentityAccounts } from '../../history/application/index.ts';
import { encodeRoles, unionHistoryScope } from '../../history/contract/index.ts';

import { COLLECTION_PUBLICATION_COMMAND, COLLECTION_PUBLICATION_WORKFLOW } from '../contract/index.ts';
import {
  loadCollectionPublicationCreation as load,
  loadCollectionPublicationLocator as loadLocator,
  readCollectionPublicationMeaning as readCurrentMeaning,
  readCollectionPublicationEpisode,
  readCollectionPublicationRule,
  retireCollectionPublicationWork,
  canonicalPublicationData as canonical,
  hashPublicationData as hash,
  exactPublicationObject as exact,
  type CollectionPublicationEpisodes,
  type CollectionPublicationMeaning as Meaning,
} from '../collection-publication-episodes.ts';

export interface NativeCollectionPublicationCommandPorts {
  commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext;
  deadlineClient(client: AccessClient, deadline: number): AccessClient;
  denied(): Error;
}
const unavailable = () => new ProblemError('dependency_unavailable');
const conflict = () => new ProblemError('conflict');

type Client = Pick<PoolClient, 'query'>;
function privateWorkingIdentity(
  identity: NativeSourceIdentity,
): identity is CollectionPublicationSource['input']['identity'] {
  return identity.scope === 'private_builtin';
}
function admitsWorkingPublication(
  saved: SavedCollectionRule,
  metadata: Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata'],
  actorId: string,
  revision: number,
): metadata is NonNullable<Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata']> {
  return (
    !!metadata &&
    metadata.curatorAccountId === actorId &&
    metadata.sourceGeneration === saved.sourceGeneration &&
    metadata.revision === revision &&
    (saved.source.kind === 'catalogue'
      ? metadata.authority === 'unavailable_output'
      : metadata.authority === 'private_builtin')
  );
}
function metadataAllowance(): WorkAllowance {
  // Fixed metadata read only: no candidate/exhaustion budget or private fact hydration.
  return {
    reservationId: 'collection-publication-metadata',
    remaining: {
      candidateKeys: 0,
      nativeRows: 4096,
      nativePoints: 32,
      statements: 32,
      emptySeeks: 32,
      witnessKeys: 0,
      identityMetadataRows: 0,
      bytes: 128 * 1024,
    },
  };
}
/** Ordinary authenticated collection:update, including fresh admission BEFORE receipt lookup on every replay. */
export function createNativeCollectionPublicationEpisodes(
  config: {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
  },
  ports: NativeCollectionPublicationCommandPorts,
): CollectionPublicationEpisodes {
  const { pool, access } = config;
  return {
    async begin(actor, request, requestKey, creation) {
      const input = structuredClone(request);
      if (
        actor.kind !== 'account' ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !exact(input, ['collectionId', 'revision', 'visibility']) ||
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0 ||
        typeof requestKey !== 'string' ||
        !/^[\x21-\x7e]{1,255}$/.test(requestKey) ||
        (input.visibility !== 'public' && input.visibility !== 'unlisted')
      )
        throw new ProblemError('invalid_request');
      const route = routeOf(input.collectionId);
      if (route === null || routeOf(actor.accountId) !== route) throw ports.denied();
      if (!actor.scopes.includes('collection:read') || (creation && !actor.scopes.includes('collection:update')))
        throw ports.denied();
      const identity = principalCommandIdentity(actor),
        deadline = deadlineFor(30000);
      const requestDigest = createHash('sha256')
        .update(canonical([identity, COLLECTION_PUBLICATION_COMMAND, creation ? { create: creation.input } : input]))
        .digest();
      const resource = { route, id: input.collectionId };
      const materialization = creation
        ? { ...creation, key: null }
        : await prepareBuiltinMaterialization(config, actor, input, deadline);
      const ordinary =
        materialization?.authorization ??
        resourceAuthorization({
          access,
          actor,
          action: 'collection:update',
          anchor: {
            resource,
            async validate(client) {
              const row = await readCollection(client, route, input.collectionId);
              return (
                row?.state === 'active' && row.curatorAccountId === actor.accountId && row.membershipKind === 'dynamic'
              );
            },
          },
          context: { pool, deadline, partition: partitionOf(route) },
        });
      const authorization: CommandAuthorization = {
        ...ordinary,
        async prepare(attempt) {
          const proof = await ordinary.prepare!(attempt);
          const meaning: Meaning | null = materialization
            ? { rule: materialization.rule, key: materialization.key }
            : await readCurrentMeaning(ports.deadlineClient(pool, deadline), route, input.collectionId);
          if (!meaning) throw unavailable();
          const saved = meaning.rule;
          const admission = await admitSavedCollectionMemberQuery(
            { ...config, clock: () => new Date(authoritativeTimeValue(attempt.time)) },
            actor,
            saved,
            {},
            deadline,
          );
          const checks = [
            ...(await prepareCollectionRuleAuthority(config, actor, saved.filter, attempt, deadline)),
            ...(await prepareNativeCollectionMemberAuthority(
              config,
              actor,
              admission,
              attempt.time,
              deadline,
              attempt,
            )),
            ...(materialization
              ? []
              : [
                  await accessCheck(
                    access,
                    actor,
                    'collection:read',
                    resource,
                    ports.commandAccessContext({ pool, deadline }, attempt),
                  ),
                ]),
          ];
          const capture = await captureDurableInitiator(ports.commandAccessContext({ pool, deadline }, attempt), actor);
          const metadata = materialization
            ? null
            : (
                await readNativeCollectionWorkingMetadata(
                  pool,
                  { route, collectionId: input.collectionId },
                  { deadline, allowance: metadataAllowance() },
                )
              ).metadata;
          if (!materialization && !admitsWorkingPublication(saved, metadata, actor.accountId, saved.collectionRevision))
            throw unavailable();
          return {
            proof,
            meaning,
            saved,
            checks,
            capture,
            metadata,
            actorSnapshot: {
              kind: 'account' as const,
              accountId: actor.accountId,
              clientId: actor.clientId,
              requestedBy: actor.requestedBy,
              authnEpoch: actor.authnEpoch,
              scopes: [...actor.scopes],
            },
          };
        },
        async authorize(tx, attempt, evidence) {
          const prepared = evidence as Prepared;
          // Evidence is produced only by the above prepare for this ordinary native attempt.
          const mode = await ordinary.authorize(tx, attempt, prepared.proof);
          await authorizeCollectionRule(tx, attempt, prepared.checks);
          await shareAccount(tx, actor.accountId);
          const prior = (
            await tx.query<{ sourceId: string; publicationId: string }>(
              `SELECT source_id::text AS "sourceId",publication_id::text AS "publicationId"
           FROM library.collection_publication_operation WHERE route=$1 AND owner_account_id=$2 AND creation_key=$3`,
              [route, actor.accountId, requestKey],
            )
          ).rows[0];
          const initialized =
            !prior &&
            (
              await tx.query(
                `INSERT INTO library.fact_source_head(route,account_id,generation)
          VALUES($1,$2,1) ON CONFLICT DO NOTHING RETURNING generation`,
                [route, actor.accountId],
              )
            ).rows.length === 1;
          const fact = (
            await tx.query<{ generation: string }>(
              'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR SHARE',
              [route, actor.accountId],
            )
          ).rows[0];
          if (
            !fact ||
            (prepared.metadata &&
              !(
                prepared.metadata.factFence === fact.generation ||
                (prepared.metadata.factFence === null && initialized && fact.generation === '1')
              ))
          )
            throw unavailable();
          if (prior) {
            const original = await load(tx, {
              route,
              id: prior.publicationId,
              kind: COLLECTION_PUBLICATION_COMMAND,
              sourceId: prior.sourceId,
            });
            if (!original || original.phase === 'refused') throw unavailable();
            if (original.creation.initiator.creation.requestDigest !== requestDigest.toString('hex'))
              throw new IdempotencyConflictError(partitionOf(route));
            if (creation) {
              // A concurrent retry may have allocated a different unused candidate ID before the receipt lock.
              const collection = await readCollection(tx, route, original.creation.source.locator.collectionId);
              if (!collection || collection.state !== 'active' || collection.curatorAccountId !== actor.accountId)
                throw new ProblemError('not_found');
            }
            const completed =
              original.phase === 'complete' &&
              (await readCollectionPublicationEpisode(tx, original.creation.source.locator))?.phase === 'complete';
            if (
              !creation &&
              (!(await readCollectionPublicationRule(tx, original.creation.source.locator)) ||
                !prepared.metadata ||
                (!completed &&
                  !isDeepStrictEqual(
                    original.creation.source.input.identity,
                    await readCurrentInput(tx, prepared.metadata),
                  )))
            )
              throw unavailable();
          }
          const current = await readCurrentMeaning(tx, route, input.collectionId);
          if (creation) {
            if (!prior && current !== null) throw conflict();
          } else if (materialization ? current !== null : !isDeepStrictEqual(current, prepared.meaning))
            throw conflict();
          return mode;
        },
        async finalize(tx, attempt, evidence) {
          const prepared = evidence as Prepared;
          await ordinary.finalize?.(tx, attempt, prepared.proof);
        },
      };
      type Prepared = {
        actorSnapshot: AccountActor;
        proof: unknown;
        saved: SavedCollectionRule;
        meaning: Meaning;
        checks: Awaited<ReturnType<typeof prepareCollectionRuleAuthority>>;
        capture: Awaited<ReturnType<typeof captureDurableInitiator>>;
        metadata: Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata'];
      };
      // Invocation-local evidence; not serialized work authority or a durable actor cache.
      let prepared: Prepared | undefined;
      const prepare = authorization.prepare!;
      authorization.prepare = async (attempt) => (prepared = (await prepare(attempt)) as Prepared);
      return runCommand(
        pool,
        {
          ...identity,
          partition: partitionOf(route),
          deadline,
          ...(config.clock ? { clock: config.clock } : {}),
          receipt: { kind: COLLECTION_PUBLICATION_COMMAND, key: requestKey, digest: requestDigest },
          authorization,
        },
        async (tx, command) => {
          if (!prepared || currentCommand(tx).time !== command.time) throw unavailable();
          const collection = creation ? await creation.materialize(tx) : undefined;
          if (materialization) {
            if (!creation) await materialization.materialize(tx);
          } else {
            // CAS holds the actual header through commit without rewriting A's native Source fence.
            const current = (
              await tx.query<{ revision: number }>(
                `SELECT revision FROM library.collection
          WHERE route=$1 AND collection_id=$2 AND state='active' FOR UPDATE`,
                [route, input.collectionId],
              )
            ).rows[0];
            if (!current || current.revision !== input.revision) throw conflict();
            if (!isDeepStrictEqual(await readCurrentMeaning(tx, route, input.collectionId), prepared.meaning))
              throw conflict();
          }
          const metadata = (
            await readNativeCollectionWorkingMetadata(
              pool,
              { route, collectionId: input.collectionId },
              { commandTx: tx, deadline, allowance: metadataAllowance() },
            )
          ).metadata;
          if (
            !admitsWorkingPublication(prepared.saved, metadata, actor.accountId, materialization ? 1 : input.revision)
          )
            throw unavailable();
          const identity = await initializeCanonicalCollectionSource(tx, {
            pool,
            route,
            collectionId: input.collectionId,
            deadline,
            allowance: metadataAllowance(),
          });
          // Allocation is real native Source storage, with no capture/observation/repair/complete evidence yet.
          if (!identity || !privateWorkingIdentity(identity)) throw unavailable();
          const locator: CollectionPublicationLocator = {
            route,
            ownerAccountId: actor.accountId,
            collectionId: input.collectionId,
            publicationId: newId(route),
          };
          const sourceId = newId(route),
            output = { route, collectionId: input.collectionId, generation: newId(route) };
          const rule: CollectionPublicationRuleRef = {
            ...(prepared.meaning.key
              ? { kind: 'builtin' as const, key: prepared.meaning.key }
              : { kind: 'saved' as const, revision: prepared.saved.revision }),
            collectionRevision: metadata.revision,
            sourceGeneration: prepared.saved.sourceGeneration,
            releaseDigest: prepared.saved.releaseDigest,
            incarnation: metadata.incarnation,
            digest: hash({
              filter: prepared.saved.filter,
              sort: prepared.saved.sort,
              releaseDigest: prepared.saved.releaseDigest,
            }),
          };
          const source: CollectionPublicationSource = {
            locator,
            input: { kind: 'private_working_source', identity },
            target: {
              kind: 'collection_output',
              route,
              collectionId: input.collectionId,
              visibility: input.visibility,
            },
            rule,
            output,
          };
          const record: DurableInitiatorRecord = {
            operation: { route, id: locator.publicationId, kind: COLLECTION_PUBLICATION_COMMAND, sourceId },
            initiatorAccountId: actor.accountId,
            actor: prepared.actorSnapshot,
            ...prepared.capture,
            sourceDigest: hash(source),
            recordedTransactionId: command.transactionId,
            creation: {
              commandKind: COLLECTION_PUBLICATION_COMMAND,
              idempotencyKey: requestKey,
              requestDigest: requestDigest.toString('hex'),
              target: resource,
            },
          };
          const commitment = durableInitiatorCommitment(record),
            receipt = currentCommandReceipt(tx);
          if (
            receipt.principal.kind !== 'account' ||
            receipt.principal.id !== actor.accountId ||
            receipt.kind !== COLLECTION_PUBLICATION_COMMAND ||
            receipt.key !== requestKey
          )
            throw unavailable();
          const pending = await tx.query<{ publicationId: string; owner: string }>(
            `SELECT publication_id::text AS "publicationId",owner_account_id::text AS owner
             FROM library.collection_publication_episode
             WHERE route=$1 AND collection_id=$2 AND phase IN ('staging','awaiting_activation') LIMIT 1`,
            [route, input.collectionId],
          );
          const prior = pending.rows[0];
          if (prior) {
            const priorLocator = {
              route,
              collectionId: input.collectionId,
              ownerAccountId: prior.owner,
              publicationId: prior.publicationId,
            };
            const original = await loadLocator(tx, priorLocator);
            // Missing immutable evidence is not proof of obsolete work. Keep it unavailable,
            // rather than treating an unverified row as permission to create another producer.
            if (!original) throw unavailable();
            if (
              (await readCollectionPublicationRule(tx, priorLocator)) &&
              isDeepStrictEqual(original.creation.source.input.identity, identity)
            )
              throw conflict();
            await retireCollectionPublicationWork(tx, route, input.collectionId);
          }
          // One current build is enforced by the native pending index. Historical native outputs
          // keep their immutable references and custody; they are never enumerated or reclaimed here.
          // Unknown whole-query cardinality stays NULL until real exhaustion. No selected-set count or complete receipt.
          await tx.query(
            `INSERT INTO library.collection_source_output(route,collection_id,generation,source_generation,account_id,expected_members,output_mode)
        VALUES($1,$2,$3,$4,$5,NULL,'whole_query')`,
            [route, input.collectionId, output.generation, rule.sourceGeneration, actor.accountId],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_operation
        (route,publication_id,source_id,collection_id,owner_account_id,transaction_id,record,source_digest,commitment,creation_storage_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              route,
              locator.publicationId,
              sourceId,
              input.collectionId,
              actor.accountId,
              command.transactionId,
              record,
              record.sourceDigest,
              commitment,
              receipt.storageKey,
            ],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_source(route,source_id,publication_id,transaction_id,bytes)
        VALUES($1,$2,$3,$4,$5)`,
            [route, sourceId, locator.publicationId, command.transactionId, canonical(source)],
          );
          await tx.query(
            `INSERT INTO library.collection_publication_episode(route,publication_id,source_id,collection_id,owner_account_id)
        VALUES($1,$2,$3,$4,$5)`,
            [route, locator.publicationId, sourceId, input.collectionId, actor.accountId],
          );
          await stageHistoryWork(tx, {
            owner: 'library',
            intent: {
              queue: 'workflows',
              workflowName: COLLECTION_PUBLICATION_WORKFLOW,
              workflowId: locator.publicationId,
              input: { accounts: [actor.accountId], ...locator },
            },
            scope: unionHistoryScope('durable-work/v1', commandHistoryIdentityAccounts(tx), [
              {
                accountRoute: route,
                accountId: actor.accountId,
                roles: encodeRoles(['owner', 'actor', 'durable-initiator']),
              },
            ]),
          });
          return {
            value: { locator, durableInitiator: commitment, ...(collection ? { collection } : {}) },
            events: [
              {
                type: 'com.rezics.library.collection.updated.v1',
                subject: input.collectionId,
                data: { collectionId: input.collectionId },
              },
            ],
          };
        },
      );
    },
  };
}
/** Actual sole Source producer's existing row, selected by its native metadata fence. */
async function readCurrentInput(
  client: Client,
  metadata: NonNullable<Awaited<ReturnType<typeof readNativeCollectionWorkingMetadata>>['metadata']>,
) {
  return (
    (
      await client.query<{ identity: CollectionPublicationSource['input']['identity'] }>(
        `SELECT identity FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`,
        [metadata.route, metadata.collectionId, nativeSourceFence(metadata)],
      )
    ).rows[0]?.identity ?? null
  );
}
