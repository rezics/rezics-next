/** Restored human command admission only. Mechanical publication work never uses this helper. */
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import { createInitiatorRestorer, DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import type { CommandAttempt, CommandAuthorization } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  CollectionPublicationCreation,
  CollectionPublicationFinalCommand,
  CollectionPublicationWorkerDependencies,
} from './collection-publication-episode-contract.ts';
import anchorQuery from './collection-publication-final-anchor.sql';

/** Construct runCommand options, not an activation or a readiness receipt.
 *
 * readOperation must be the original Library native operation/source/receipt reader. This helper
 * supplies no fallback reader. The final native body must additionally prove the current whole
 * query seal, rule, Source, custody, identity and output fences before invoking output hooks.
 * Until those producers exist, callers cannot use admission alone to complete an episode.
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
  const { workContext, readOperation } = dependencies;
  const { pool } = workContext;
  const { access, readConsent } = workContext.getAuthorization();
  const restorer = createInitiatorRestorer({
    pool,
    access,
    readConsent,
    async readOperation(client, requested, time) {
      const original = await readOperation(client, requested, time);
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
      const row = await anchorQuery.run(client, { route, collection_id: collectionId, owner_account_id: ownerAccountId });
      return row?.valid === true;
    },
  });
  type Prepared = { attempt: CommandAttempt; current: CommandAuthorization; proof: unknown };
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
      const current = resourceAuthorization({
        access,
        actor,
        action: 'collection:update',
        anchor,
        context: { pool, deadline, partition },
      });
      const proof = await current.prepare!(attempt);
      const evidence = Object.freeze({});
      proofs.set(evidence, { attempt, current, proof });
      return evidence;
    },
    async authorize(tx, attempt, evidence) {
      const prepared = typeof evidence === 'object' && evidence !== null ? proofs.get(evidence) : undefined;
      if (typeof evidence === 'object' && evidence !== null) proofs.delete(evidence);
      if (!prepared || prepared.attempt !== attempt) throw denied();
      if ((await prepared.current.authorize(tx, attempt, prepared.proof)) !== 'execute') throw denied();
      return 'execute';
    },
  });
  return Object.freeze({ ...identity, partition, deadline, clock: workContext.clock, authorization });
}
