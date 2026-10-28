import { type AuthoritativeTime, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { type Access, type AccessClient, type AccessContext, type Actor, type Resource } from '../request/access.ts';
import { type ResourceCreationManifest } from './creation-manifest.ts';
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
/** Only binds module data written in the same command to a resource that command
 * is creating. This read-only in-memory predicate reads no database row and issues
 * no statement; it grants nothing and is not a permission check.
 */
export declare function creationDeclares(tx: CommandTransaction, resource: Readonly<Resource>): boolean;
/** Internal exact-tuple reservation. A pending entry becomes complete only when
 * the native initializer confirms successful grant writes. Any failed, concurrent
 * or repeated use poisons the attempt, even if the body catches the exception.
 * Generic resource authorization never installs this transaction capability.
 */
export declare function creationCapability(tx: CommandTransaction, resource: Resource, creator: string, type?: string): Promise<Readonly<{
    access: Access;
    time: AuthoritativeTime;
    complete(): void;
}>>;
/** Prepare independently anchored identity/org evidence before checking out the
 * parent. The sole resource formula then runs on the parent at the attempt's T;
 * the connection is released before runCommand checks out the child partition.
 * Both preparation and proof minting repeat on every serialization/fence retry.
 */
export declare function parentCreationAuthorization(input: {
    access: Access;
    actor: Actor;
    action: string;
    parent: ParentAnchor;
    context: ParentCreationContext;
}): CommandAuthorization;
