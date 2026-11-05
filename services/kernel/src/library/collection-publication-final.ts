/** Restored human command admission only. Mechanical publication work never uses this helper. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { PoolClient } from 'pg';
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import { createInitiatorRestorer, DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  registerCommandCallback,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { scopeAllowance, zeroScopeWork } from '../search/scope-execution.ts';
import { deadlineFor } from '../request/deadline.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  CollectionPublicationEpisode,
  CollectionPublicationFinalActivation,
  CollectionPublicationCreation,
  CollectionPublicationFinalCommand,
  CollectionPublicationFinalResult,
  CollectionPublicationWorkerDependencies,
} from './collection-publication-episode-contract.ts';
import {
  readCollectionPublicationInitiator,
  readCollectionPublicationEpisode,
  readCollectionPublicationEpisodeVersion,
  readCollectionPublicationRule,
} from './collection-publication-episodes.ts';
import type { CollectionPublicationLocator } from './collection-publication-work-admission.ts';
import type { WorkDimensions } from './collection-source.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { accessCheck, type AccessCheck } from '../request/access.ts';
import { readBuiltinPublicationRule } from './builtin-materialization.ts';
import { authorizeCollectionRule, collectionRuleActions, readSavedCollectionRule } from './collection-rules.ts';
import { admitSavedCollectionMemberQuery, collectionMemberPrivateReads } from './owner-filter.ts';
import { completeCollectionSourceOutput, type CollectionOutputRef } from './collection-source-output.ts';
import { readCollectionPublicationStagingSeal } from './collection-publication-staging.ts';
import outputInventoryQuery from './collection-publication-final-output-inventory.sql';
import outputCommitQuery from './collection-publication-final-output-commit.sql';
import completeEpisodeQuery from './collection-publication-final-episode-complete.sql';
import currentCollectionQuery from './collection-publication-final-state.sql';
import anchorQuery from './collection-publication-final-anchor.sql';

type Client = Pick<PoolClient, 'query'>;
type FinalAttempt = Readonly<{
  attempt: CommandAttempt;
  proof: unknown;
  work: NativeCollectionWork;
}>;
type OutputInventoryRow = Readonly<{ generation: string; state: string; outputMode: string }>;
const unavailable = () => new ProblemError('dependency_unavailable');
const finalCommandKind = 'library.collection.publication.activate';
const receiptKeyPattern = /^[\x21-\x7e]{1,255}$/;

function metadataFootprint(): WorkDimensions {
  // Same fixed metadata envelope used by the native episode reader; it never reserves candidate keys.
  return {
    ...zeroScopeWork(),
    nativeRows: 4096,
    nativePoints: 32,
    statements: 32,
    bytes: 128 * 1024,
    emptySeeks: 32,
  };
}

async function bounded<T>(
  work: NativeCollectionWork,
  footprint: WorkDimensions,
  operation: () => Promise<T>,
): Promise<T> {
  const reservation = work.reserve(footprint);
  reservation.dispatch();
  try {
    return await operation();
  } finally {
    reservation.settle();
  }
}

function creationOf(episode: CollectionPublicationEpisode): CollectionPublicationCreation {
  return {
    source: episode.source,
    initiator: episode.initiator,
    durableInitiator: episode.durableInitiator,
  };
}

function pending(
  episode: CollectionPublicationEpisode,
): episode is Extract<CollectionPublicationEpisode, { phase: 'staging' | 'awaiting_activation' }> {
  return episode.phase === 'staging' || episode.phase === 'awaiting_activation';
}

function sameOutput(a: CollectionOutputRef, b: CollectionOutputRef): boolean {
  return a.route === b.route && a.collectionId === b.collectionId && a.generation === b.generation;
}

function validSeal(
  locator: CollectionPublicationLocator,
  output: CollectionOutputRef,
  seal: Awaited<ReturnType<typeof readCollectionPublicationStagingSeal>>,
): seal is NonNullable<typeof seal> {
  return !!(
    seal &&
    sameOutput(seal.output, output) &&
    seal.publicationId === locator.publicationId &&
    /^[0-9a-f]{64}$/.test(seal.definitionDigest) &&
    /^(0|[1-9][0-9]*)$/.test(seal.members) &&
    /^(0|[1-9][0-9]*)$/.test(seal.position) &&
    seal.nativeXid.length > 0 &&
    /^(0|[1-9][0-9]*)$/.test(seal.version)
  );
}

async function readFinalEpisode(client: Client, locator: CollectionPublicationLocator) {
  return readCollectionPublicationEpisode(client, locator);
}

/** A result reader, not an authority adapter. It discloses only a currently selected native COMPLETE output. */
export async function readCollectionPublicationFinalResult(
  client: Client,
  locator: CollectionPublicationLocator,
): Promise<CollectionPublicationFinalResult | null> {
  const episode = await readFinalEpisode(client, locator);
  if (!episode || episode.phase !== 'complete' || episode.output.state !== 'complete') return null;
  return {
    locator: episode.source.locator,
    phase: 'complete',
    output: episode.output.ref,
  };
}

/** Construct runCommand authorization options from an immutable native creation record.
 *
 * The Library's actual operation/source/creation-receipt reader is bound directly into restoration.
 * This helper supplies no fallback reader. The final body also proves the current whole-query seal,
 * rule, Source, custody, identity and output fences before invoking the output hooks.
 *
 * The principal/basis below are immutable provenance DATA. Only restoration and the mounted Access
 * formula at each attempt's T authorize execution, including before runCommand's receipt lookup.
 */
export function createCollectionPublicationFinalCommand(
  dependencies: CollectionPublicationWorkerDependencies,
  creation: CollectionPublicationCreation,
  deadline: number,
): CollectionPublicationFinalCommand {
  const denied = () => new DurableInitiatorUnavailableError();
  // Take only primitive lookup/attribution data. Never retain or rehydrate a captured Actor for use
  // in Access; the restorer obtains its own original record through the native reader each time.
  const { source, initiator } = creation;
  const expected = durableInitiatorCommitment(initiator);
  const route = source.target.route;
  const collectionId = source.target.collectionId;
  const ownerAccountId = source.locator.ownerAccountId;
  if (
    expected !== creation.durableInitiator ||
    !Number.isFinite(deadline) ||
    routeOf(collectionId) !== route ||
    source.locator.route !== route ||
    source.locator.collectionId !== collectionId ||
    source.target.kind !== 'collection_output' ||
    (source.target.visibility !== 'public' && source.target.visibility !== 'unlisted') ||
    source.input.kind !== 'private_working_source' ||
    source.input.identity.scope !== 'private_builtin' ||
    source.input.identity.route !== route ||
    source.input.identity.collectionId !== collectionId ||
    source.input.identity.accountId !== ownerAccountId ||
    source.output.route !== route ||
    source.output.collectionId !== collectionId ||
    initiator.initiatorAccountId !== ownerAccountId ||
    initiator.actor.accountId !== ownerAccountId ||
    initiator.creation.target.route !== route ||
    initiator.creation.target.id !== collectionId
  )
    throw denied();

  const operation = Object.freeze({ ...initiator.operation });
  const identity = Object.freeze({
    principal: Object.freeze({ kind: 'account' as const, id: initiator.initiatorAccountId }),
    basis: Object.freeze({ clientId: initiator.actor.clientId, requestedBy: initiator.actor.requestedBy }),
  });
  const { workContext } = dependencies;
  const { pool } = workContext;
  const { access, readConsent } = workContext.getAuthorization();
  const restorer = createInitiatorRestorer({
    pool,
    access,
    readConsent,
    async readOperation(client, requested, time) {
      const original = await readCollectionPublicationInitiator(client, requested, time);
      // Independent native provenance verification belongs to readOperation. Compare its entire
      // original tuple as well: changed creation data cannot borrow this command's attribution.
      return original && durableInitiatorCommitment(original) === expected ? original : null;
    },
  });
  const partition = partitionOf(route);
  const resource = Object.freeze({ route, id: collectionId });
  const anchor = Object.freeze({
    resource,
    async validate(client: Parameters<typeof anchorQuery.run>[0]) {
      const row = await anchorQuery.run(client, {
        route,
        collection_id: collectionId,
        owner_account_id: ownerAccountId,
      });
      return row?.valid === true;
    },
  });
  type Prepared = {
    attempt: CommandAttempt;
    current: CommandAuthorization;
    proof: unknown;
    checks: readonly AccessCheck[];
  };
  const proofs = new WeakMap<object, Prepared>();
  const authorization: CollectionPublicationFinalCommand['authorization'] = Object.freeze({
    action: 'collection:update',
    resource,
    denied,
    async prepare(attempt: CommandAttempt) {
      const actor = await restorer.restoreInitiator(
        { operation, action: 'collection:update', anchor, context: { pool, deadline } },
        attempt.time,
      );
      // A restored collection:update grant alone cannot publish a private predicate. Re-admit
      // the current whole rule and every expanded private family at this exact command time,
      // including on receipt replay. The body separately compares the immutable episode meaning.
      if (!actor.scopes.includes('collection:read')) throw denied();
      const client = deadlineClient(pool, deadline);
      const rule =
        (await readSavedCollectionRule(client, route, collectionId)) ??
        (await readBuiltinPublicationRule(client, route, collectionId))?.rule;
      if (!rule) throw unavailable();
      const config = { pool, access, clock: () => new Date(authoritativeTimeValue(attempt.time)) };
      const admission = await admitSavedCollectionMemberQuery(config, actor, rule, {}, deadline);
      const ownerAnchor = {
        resource: { route, id: ownerAccountId },
        async validate(client: Client) {
          const account = await readAccount(client, route, ownerAccountId);
          return account?.kind === 'actor' && account.state === 'active' && !account.fenced;
        },
      };
      const families = [
        ...collectionRuleActions(rule.filter).map((action) => ({
          action,
          group: action === 'progress_session:read' ? 'reading_progress' : 'personal_library',
        })),
        ...collectionMemberPrivateReads(admission.filter ?? rule.filter),
      ];
      const checks: AccessCheck[] = [];
      // Durable identities are bound to one action and resource. Restore each required
      // read separately; the collection:update identity cannot authorize those reads.
      for (const family of [{ action: 'collection:read', group: null }, ...families]) {
        const target = family.group === null ? anchor : ownerAnchor;
        const reader = await restorer.restoreInitiator(
          { operation, action: family.action, anchor: target, context: { pool, deadline } },
          attempt.time,
        );
        if (family.group !== null)
          await admitGroup({
            pool,
            access: () => access,
            actor: reader,
            group: family.group,
            clientAction: family.action,
            deadline,
            clock: config.clock,
          });
        checks.push(
          await accessCheck(
            access,
            reader,
            family.action,
            target.resource,
            commandAccessContext({ pool, deadline }, attempt),
          ),
        );
      }
      const current = resourceAuthorization({
        access,
        actor,
        action: 'collection:update',
        anchor,
        context: { pool, deadline, partition },
      });
      const proof = await current.prepare!(attempt);
      const evidence = Object.freeze({});
      proofs.set(evidence, { attempt, current, proof, checks });
      return evidence;
    },
    async authorize(tx, attempt, evidence) {
      const prepared = typeof evidence === 'object' && evidence !== null ? proofs.get(evidence) : undefined;
      if (typeof evidence === 'object' && evidence !== null) proofs.delete(evidence);
      if (!prepared || prepared.attempt !== attempt) throw denied();
      if ((await prepared.current.authorize(tx, attempt, prepared.proof)) !== 'execute') throw denied();
      await authorizeCollectionRule(tx, attempt, prepared.checks);
      return 'execute';
    },
  });
  return Object.freeze({ ...identity, partition, deadline, clock: workContext.clock, authorization });
}

/** One ordinary restored-initiator command owns the A-to-B switch. The final result is freshly
 * reread from the committed native episode, after Core has sealed its real basis/receipt/outbox. */
export function createCollectionPublicationFinalActivation(
  dependencies: CollectionPublicationWorkerDependencies,
): CollectionPublicationFinalActivation {
  const { pool } = dependencies.workContext;
  return Object.freeze({
    async activate(locator, requestKey): Promise<CommandOutcome<CollectionPublicationFinalResult>> {
      if (!receiptKeyPattern.test(requestKey)) throw new ProblemError('invalid_request');
      const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
      const initialWork = new NativeCollectionWork(scopeAllowance(0, randomUUID()), deadline);
      const initial = await bounded(initialWork, metadataFootprint(), () => readFinalEpisode(pool, locator));
      if (!initial) throw unavailable();
      const creation = creationOf(initial);
      const command = createCollectionPublicationFinalCommand(dependencies, creation, deadline);
      const attempts = new WeakMap<AuthoritativeTime, FinalAttempt>();
      const denied = command.authorization.denied;
      const authorization: CollectionPublicationFinalCommand['authorization'] = Object.freeze({
        ...command.authorization,
        async prepare(attempt) {
          const proof = await command.authorization.prepare!(attempt);
          // A fresh native work ledger belongs to this exact attempt. Retries never reuse its charges.
          const work = new NativeCollectionWork(scopeAllowance(0, randomUUID()), deadline);
          attempts.set(attempt.time, { attempt, proof, work });
          return Object.freeze({});
        },
        async authorize(tx, attempt, evidence) {
          const prepared = attempts.get(attempt.time);
          if (!prepared || prepared.attempt !== attempt || typeof evidence !== 'object' || evidence === null)
            throw denied();
          if ((await command.authorization.authorize(tx, attempt, prepared.proof)) !== 'execute') throw denied();
          return 'execute';
        },
      });
      const commandIdentity = { principal: command.principal, basis: command.basis };
      const digestBytes = createHash('sha256')
        .update(canonicalize([commandIdentity, finalCommandKind, locator, creation.source, creation.durableInitiator])!)
        .digest();

      const outcome = await runCommand<{ locator: CollectionPublicationLocator }>(
        pool,
        {
          ...command,
          authorization,
          receipt: { kind: finalCommandKind, key: requestKey, digest: digestBytes },
        },
        async (tx, context) => {
          const prepared = attempts.get(context.time);
          if (!prepared || prepared.attempt.time !== context.time) throw unavailable();
          const work = prepared.work;
          const before = await bounded(work, metadataFootprint(), async () => {
            const episode = await readFinalEpisode(tx, locator);
            const rule = await readCollectionPublicationRule(tx, locator);
            const version = await readCollectionPublicationEpisodeVersion(tx, locator);
            return { episode, rule, version };
          });
          if (
            !before.episode ||
            !pending(before.episode) ||
            !isDeepStrictEqual(creationOf(before.episode), creation) ||
            before.episode.output.state !== 'building' ||
            !sameOutput(before.episode.output.ref, creation.source.output) ||
            !sameOutput(creation.source.output, before.episode.source.output) ||
            !before.rule ||
            !before.version
          )
            throw unavailable();
          const selectedBefore = before.episode.selected;
          const firstInventory = await bounded(
            work,
            {
              ...zeroScopeWork(),
              nativeRows: 3,
              nativePoints: 1,
              statements: 1,
              bytes: 4096,
              emptySeeks: 1,
            },
            async () =>
              outputInventoryQuery.run(tx, {
                route: locator.route,
                collection_id: locator.collectionId,
                generations: [
                  creation.source.output.generation,
                  ...(selectedBefore ? [selectedBefore.ref.generation] : []),
                ],
              }) as Promise<OutputInventoryRow[]>,
          );
          validateInventory(firstInventory, creation.source.output, before.episode.selected);

          // This is a fresh native query-exhaustion receipt. Phase, row count, or copied JSON cannot substitute.
          const seal = await readCollectionPublicationStagingSeal(tx, locator, work);
          if (!validSeal(locator, creation.source.output, seal)) throw unavailable();

          // Release foreign Source work, then re-read the complete local binding before output selection.
          const after = await bounded(work, metadataFootprint(), async () => {
            const episode = await readFinalEpisode(tx, locator);
            const rule = await readCollectionPublicationRule(tx, locator);
            const version = await readCollectionPublicationEpisodeVersion(tx, locator);
            const collection = await currentCollectionQuery.run(tx, {
              route: locator.route,
              collection_id: locator.collectionId,
            });
            return { episode, rule, version, collection };
          });
          if (
            !after.episode ||
            !pending(after.episode) ||
            !isDeepStrictEqual(creationOf(after.episode), creation) ||
            !isDeepStrictEqual(after.rule, before.rule) ||
            !after.version ||
            after.episode.output.state !== 'building' ||
            !sameOutput(after.episode.output.ref, creation.source.output) ||
            !isDeepStrictEqual(after.episode.selected, before.episode.selected) ||
            !after.collection ||
            after.collection.owner !== locator.ownerAccountId ||
            after.collection.state !== 'active' ||
            after.collection.membershipKind !== 'dynamic' ||
            after.collection.revision !== before.rule.collectionRevision ||
            after.collection.sourceGeneration !== before.rule.sourceGeneration ||
            after.collection.incarnation !== creation.source.rule.incarnation
          )
            throw unavailable();
          const activationEpisode = after.episode;
          const activationVersion = after.version;
          const finalInventory = await bounded(
            work,
            {
              ...zeroScopeWork(),
              nativeRows: 3,
              nativePoints: 1,
              statements: 1,
              bytes: 4096,
              emptySeeks: 1,
            },
            async () =>
              outputInventoryQuery.run(tx, {
                route: locator.route,
                collection_id: locator.collectionId,
                generations: [
                  creation.source.output.generation,
                  ...(activationEpisode.selected ? [activationEpisode.selected.ref.generation] : []),
                ],
              }) as Promise<OutputInventoryRow[]>,
          );
          validateInventory(finalInventory, creation.source.output, after.episode.selected);
          const current = currentCommand(tx);
          if (current.time !== context.time || current.authorization?.action !== 'collection:update') throw denied();

          await completeCollectionSourceOutput(tx, creation.source.output, {
            locator,
            work,
            version: activationVersion,
            phase: activationEpisode.phase,
            selected: activationEpisode.selected,
          });
          // The output hook registered its actual provenance callback first. This callback only marks the
          // episode complete after that native row exists in this same Core transaction; the committed
          // result reader verifies the final position/xid after the deferred Core fence has completed.
          registerCommandCallback(tx, async (transactionId) => {
            if (transactionId !== currentCommand(tx).transactionId) throw unavailable();
            const sourceGeneration = (BigInt(creation.source.rule.sourceGeneration) + 1n).toString();
            const [published] = await outputCommitQuery.run(tx, {
              route: locator.route,
              collection_id: locator.collectionId,
              generation: creation.source.output.generation,
              owner_account_id: locator.ownerAccountId,
              transaction_id: transactionId,
              source_generation: sourceGeneration,
              visibility: creation.source.target.visibility,
            });
            if (
              !published ||
              published.generation !== creation.source.output.generation ||
              published.transactionId !== transactionId ||
              published.sourceGeneration !== sourceGeneration ||
              !/^(0|[1-9][0-9]*)$/.test(published.members) ||
              !/^(0|[1-9][0-9]*)$/.test(published.memberFence) ||
              published.nativeXid.length === 0
            )
              throw unavailable();
            const changed = await completeEpisodeQuery.run(tx, {
              route: locator.route,
              publication_id: locator.publicationId,
              owner_account_id: locator.ownerAccountId,
              collection_id: locator.collectionId,
              version: activationVersion,
              phase: activationEpisode.phase,
            });
            if (!changed) throw unavailable();
          });
          return {
            value: { locator },
            events: [
              {
                type: 'com.rezics.library.collection.updated.v1',
                subject: locator.collectionId,
                data: { collectionId: locator.collectionId },
              },
              {
                type: 'com.rezics.library.collection.listing.changed.v1',
                subject: locator.collectionId,
                data: { collectionId: locator.collectionId },
              },
            ],
          };
        },
      );
      const resultWork = new NativeCollectionWork(scopeAllowance(0, randomUUID()), deadline);
      const result = await bounded(resultWork, metadataFootprint(), () =>
        readCollectionPublicationFinalResult(pool, locator),
      );
      if (!result) throw unavailable();
      return { ...outcome, value: result };
    },
  });
}

function validateInventory(
  rows: readonly OutputInventoryRow[],
  output: CollectionOutputRef,
  selected: CollectionPublicationEpisode['selected'],
): void {
  const build = rows.find((row) => row.generation === output.generation);
  if (!build || build.state !== 'building' || build.outputMode !== 'whole_query') throw unavailable();
  if (!selected) {
    if (rows.length !== 1) throw unavailable();
    return;
  }
  const prior = rows.find((row) => row.generation === selected.ref.generation);
  if (
    rows.length !== 2 ||
    selected.ref.generation === output.generation ||
    selected.ref.route !== output.route ||
    selected.ref.collectionId !== output.collectionId ||
    !prior ||
    prior.state !== 'complete'
  )
    throw unavailable();
}
