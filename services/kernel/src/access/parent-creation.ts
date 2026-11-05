import { accessEvidence } from './evidence.ts';
import { requireAccessDeadline } from './unavailable.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { type Access, type AccessClient, type AccessContext, type Actor, type Resource } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { validResource } from './grant-command.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import {
  creationManifestEntries,
  type ResourceCreationEntry,
  type ResourceCreationManifest,
} from './creation-manifest.ts';

/** The owning module supplies this port in service code after binding the actual
 * parent storage/identity. validate reads only that parent anchor, and must check
 * actual existence and any module-specific creation prerequisites at T. It is
 * never a public type flag or request-supplied callback. Semantic supplies its
 * seeded Global Context here; Access creates no competing parent identity.
 */
export type ParentAnchor = Readonly<{
  resource: Readonly<Resource>;
  validate(client: AccessClient, time: AuthoritativeTime): Promise<boolean>;
}>;
/** The owning child module proves its unique resource INSERT belongs to this
 * live transaction. Its implementation reads only the child anchor and checks
 * immutable creation provenance (not just existence or a caller boolean). An
 * existing row, UPDATE or upsert cannot stand in for a new resource INSERT.
 */
export type ResourceCreationPort = Readonly<{
  validate(tx: CommandTransaction, resource: Readonly<Resource>, time: AuthoritativeTime): Promise<boolean>;
}>;
/** resource is the exact NEW resource bound by the owning create command, never
 * a replacement supplied by request JSON after authorization. The owning module
 * inserts its unique resource row before initializeResourceGrants and supplies
 * its trusted creation port here. Both writes use the same command transaction.
 */
export type ParentCreationContext = AccessContext & {
  resource: Readonly<Resource>;
  creation: ResourceCreationPort;
  /** Opaque bounded declaration; every tuple must finish initialization before commit. */
  manifest?: ResourceCreationManifest;
};
type Entry = {
  resource: Readonly<Resource>;
  creator: string;
  type?: string;
  validate: ResourceCreationPort['validate'];
  state: 'pending' | 'initializing' | 'complete';
};
type Creation = {
  access: Access;
  attempt: CommandAttempt;
  proof: unknown;
  entries: Entry[];
  parent: Readonly<Resource>;
  action: string;
  deadline: number;
  failed: boolean;
  manifest: boolean;
};
const creations = new WeakMap<CommandTransaction, Creation>();

/** Only binds module data written in the same command to a resource that command
 * is creating. This read-only in-memory predicate reads no database row and issues
 * no statement; it grants nothing and is not a permission check.
 */
export function creationDeclares(tx: CommandTransaction, resource: Readonly<Resource>): boolean {
  try {
    const { route, id } = resource;
    if (typeof route !== 'number' || typeof id !== 'string' || !validResource({ route, id })) return false;
    const command = currentCommand(tx);
    const creation = creations.get(tx);
    if (
      !creation ||
      creation.failed ||
      creation.attempt.time !== command.time ||
      command.authorization?.mode !== 'execute' ||
      command.authorization.action !== creation.action ||
      command.authorization.resource.route !== creation.parent.route ||
      command.authorization.resource.id !== creation.parent.id ||
      command.basis !== creation.attempt.basis ||
      command.partition !== creation.attempt.partition
    )
      return false;
    authoritativeTimeValue(command.time);
    return creation.entries.some((entry) => entry.resource.route === route && entry.resource.id === id);
  } catch {
    return false;
  }
}

function liveCreation(tx: CommandTransaction): Creation {
  const command = currentCommand(tx);
  const creation = creations.get(tx);
  if (creation) requireAccessDeadline(creation.deadline);
  if (
    !creation ||
    creation.failed ||
    creation.attempt.time !== command.time ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== creation.action ||
    command.authorization.resource.route !== creation.parent.route ||
    command.authorization.resource.id !== creation.parent.id ||
    command.basis !== creation.attempt.basis ||
    command.partition !== creation.attempt.partition
  ) {
    if (creation) creation.failed = true;
    throw new GrantDeniedError();
  }
  authoritativeTimeValue(command.time);
  return creation;
}

/** Internal exact-tuple reservation. A pending entry becomes complete only when
 * the native initializer confirms successful grant writes. Any failed, concurrent
 * or repeated use poisons the attempt, even if the body catches the exception.
 * Generic resource authorization never installs this transaction capability.
 */
export async function creationCapability(
  tx: CommandTransaction,
  resource: Resource,
  creator: string,
  type?: string,
): Promise<Readonly<{ access: Access; time: AuthoritativeTime; complete(): void }>> {
  const creation = liveCreation(tx);
  const entry = creation.entries.find(
    (entry) => entry.resource.route === resource.route && entry.resource.id === resource.id,
  );
  if (
    !entry ||
    entry.creator !== creator ||
    (entry.type !== undefined && entry.type !== type) ||
    entry.state !== 'pending'
  ) {
    creation.failed = true;
    throw new GrantDeniedError();
  }
  if (
    type !== undefined &&
    !resourceRoleCatalogue(creation.access)?.declaredTypes?.get(creation.action)?.includes(type)
  )
    throw new TypeError(`Resource type ${type} is not declared by ${creation.action}`);
  entry.state = 'initializing';
  try {
    if (
      !(await accessEvidence(
        () => entry.validate(tx, entry.resource, creation.attempt.time),
        () => new GrantDeniedError(),
        creation.deadline,
      ))
    )
      throw new GrantDeniedError();
    liveCreation(tx);
  } catch (error) {
    creation.failed = true;
    throw error;
  }
  return Object.freeze({
    access: creation.access,
    time: creation.attempt.time,
    complete() {
      if (liveCreation(tx) !== creation || entry.state !== 'initializing') {
        creation.failed = true;
        throw new GrantDeniedError();
      }
      entry.state = 'complete';
    },
  });
}

/** Prepare independently anchored identity/org evidence before checking out the
 * parent. The sole resource formula then runs on the parent at the attempt's T;
 * the connection is released before runCommand checks out the child partition.
 * Both preparation and proof minting repeat on every serialization/fence retry.
 */
export function parentCreationAuthorization(input: {
  access: Access;
  actor: Actor;
  action: string;
  parent: ParentAnchor;
  context: ParentCreationContext;
}): CommandAuthorization {
  const { access, actor, action } = input;
  const parent = Object.freeze({ ...input.parent.resource });
  const manifest = input.context.manifest;
  const declared: readonly ResourceCreationEntry[] | undefined =
    manifest === undefined ? undefined : creationManifestEntries(manifest);
  // Manifest metadata is authoritative; legacy target/port properties are not read.
  const resource = declared?.[0]?.resource ?? Object.freeze({ ...input.context.resource });
  const { pool, deadline } = input.context;
  const validate = input.parent.validate.bind(input.parent);
  const legacyPort = declared ? undefined : input.context.creation;
  if (!declared && typeof legacyPort?.validate !== 'function') throw new GrantDeniedError();
  const validateCreation = legacyPort?.validate.bind(legacyPort);
  const basis =
    actor.kind === 'account'
      ? { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy }
      : null;
  const proofs = new WeakMap<object, { authorization: CommandAuthorization; deadline: number }>();
  const denied = () => new GrantDeniedError();
  function bound(attempt: CommandAttempt): boolean {
    return (
      basis !== null &&
      attempt.basis?.actorAccountId === basis.actorAccountId &&
      attempt.basis.clientId === basis.clientId &&
      attempt.basis.requestedBy === basis.requestedBy &&
      validResource(parent) &&
      validResource(resource) &&
      parent.id !== resource.id &&
      (!declared ||
        declared.every(
          (entry) =>
            entry.creator === basis.actorAccountId &&
            entry.resource.id !== parent.id &&
            partitionOf(entry.resource.route) === attempt.partition,
        )) &&
      attempt.partition === partitionOf(resource.route)
    );
  }
  return Object.freeze<CommandAuthorization>({
    action,
    resource: parent,
    denied,
    async prepare(attempt) {
      requireAccessDeadline(deadline);
      if (!bound(attempt)) throw denied();
      let proofDeadline = -Infinity;
      // One helper per attempt lets the creation wrapper retain the exact evidence
      // deadline without exposing it or adding creation rights to the generic API.
      const authorization = resourceAuthorization({
        access: {
          authenticate: access.authenticate.bind(access),
          authorize: access.authorize.bind(access),
          async prepare(...args) {
            // Forward the exact context: its opaque live-attempt admission marker
            // must reach the installed Access without copying or refreshing twice.
            const evidence = await access.prepare?.(...args);
            proofDeadline = Math.min(deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
            return evidence;
          },
        },
        actor,
        action,
        anchor: { resource: parent, validate },
        context: { pool, deadline, partition: partitionOf(resource.route) },
      });
      const proof = await authorization.prepare!(attempt);
      requireAccessDeadline(deadline);
      if (typeof proof !== 'object' || proof === null || !bound(attempt)) throw denied();
      proofs.set(proof, { authorization, deadline: proofDeadline });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      requireAccessDeadline(deadline);
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (prepared) requireAccessDeadline(prepared.deadline);
      if (!bound(attempt) || !prepared) throw denied();
      proofs.delete(proof as object);
      if (
        (await accessEvidence(() => prepared.authorization.authorize(tx, attempt, proof), denied, deadline)) !==
        'execute'
      )
        throw denied();
      creations.set(tx, {
        access,
        attempt,
        proof,
        entries: declared
          ? declared.map((entry) => ({
              resource: entry.resource,
              creator: entry.creator,
              type: entry.type,
              validate: entry.creation.validate.bind(entry.creation),
              state: 'pending',
            }))
          : [{ resource, creator: basis!.actorAccountId, validate: validateCreation!, state: 'pending' }],
        failed: false,
        manifest: declared !== undefined,
        parent,
        action,
        deadline: prepared.deadline,
      });
      return 'execute';
    },
    async finalize(tx, attempt, proof) {
      const creation = liveCreation(tx);
      if (
        creation.attempt !== attempt ||
        creation.proof !== proof ||
        (creation.manifest && creation.entries.some((entry) => entry.state !== 'complete')) ||
        creation.entries.some((entry) => entry.state === 'initializing')
      ) {
        creation.failed = true;
        throw denied();
      }
      creations.delete(tx);
    },
  });
}
