import type { AccountWorkflowOptions, AuthService } from '@rezics/auth';
import type { AccessConfig } from '../../src/access/index.ts';
import type { KernelDependencies } from '../../src/http/kernel.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import type { GrowthDatabase } from '../support/growth.ts';

export const MISSING_IMPORT_IDENTITY = 'openImportIdentity is not implemented';

export interface ImportIdentityOptions {
  /** Caller-owned, isolated, migrated application DB; use this exact capture pool throughout. */
  readonly database: GrowthDatabase;
  readonly clock: NonNullable<AccountWorkflowOptions['clock']>;
}

export interface ImportCredential {
  readonly accountId: AccountActor['accountId'];
  /** Actual Auth-issued token; its sub is accountId, including for the automated importer. */
  readonly bearer: string;
}

/** Private test composition for identity only. Bulk/media/routes remain in imports-api.test.ts. */
export interface ImportIdentity {
  readonly database: GrowthDatabase;
  readonly access: Access;
  readonly accessConfig: AccessConfig;
  readonly routeKey: KernelDependencies['routeKey'];
  readonly tokenKeys: NonNullable<KernelDependencies['tokens']>;
  readonly auth: AuthService;
  readonly client: Parameters<AuthService['internal']['registerClient']>[0];
  readonly governance: ImportCredential;
  readonly bulk: ImportCredential;
  readonly ordinary: ImportCredential;
  /** Real grant commands change only subject:batch_write on the sole GlobalContext.
   * Preserve tokens, consent, other grants and receipts; never issue a replacement token. */
  setBulkPermission(enabled: boolean): Promise<void>;
  /** Idempotent; release isolated Auth/workflow resources, including after partial failure.
   * The caller retains ownership of database and closes it after this fixture. */
  close(): Promise<void>;
}

/** Pending accounts composition must bind durable pending-receipt locators and approvals,
 * not grant-fixture/standing-fixture SQL, provisioning sets or workflow approval maps.
 * Use createLifecycleInternals/createLifecycleCommands, createRegistrationProofBindings,
 * createAuthBindings, Auth's createProvisioningEvidenceVerifier/createAccountWorkflows,
 * createOperatorSessionCapability/createOperatorCommands and real grant/delegation commands.
 * Bootstrap only through bootstrap-governance.ts --account <id> or its exported entrypoint;
 * no Access-row inserts or public HTTP bootstrap. All later grants use the normal formula.
 * Setup namespace/schema/migration SQL and read-only observation are the only SQL exemptions.
 * Auth may own an isolated realm/database; clean it even when opening fails. Nested Auth,
 * Access and receipts must share database's actual auto_explain capture via its pools.
 * Fixed actors/grants and <=1000 memberships; exact partition/marker/account/grant seeks,
 * never a full Access scan, history enumeration, static cost counters or timing oracle.
 */
export async function openImportIdentity(_options: ImportIdentityOptions): Promise<ImportIdentity> {
  throw new Error(MISSING_IMPORT_IDENTITY);
}
