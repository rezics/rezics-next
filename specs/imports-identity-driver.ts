/**
 * PRIVATE TEST SUPPORT. IMPORT_IDENTITY_DRIVER names an absolute file/URL exporting
 * createImportIdentityDriver. No contentSystem dependency or production/public port.
 * open creates an isolated migrated application GrowthDatabase, then calls the real
 * openImportIdentity({database, clock}); the helper must retain that exact database/pool.
 * All application work uses that pool; Auth may own an isolated realm/database with cleanup.
 * release owns application DB cleanup after identity.close; both tolerate repeated calls.
 * Every failed open releases all partial resources before rejecting with the original error.
 * afterStage runs after the actual named effect, solely to inject a caller failure.
 *
 * Observers return native module reads/persisted evidence, never predicted outcomes.
 * Grant evidence follows the fixed issued command locators, not a full Access scan.
 * Bootstrap invokes services/kernel/scripts/bootstrap-governance.ts --account <id>
 * with DB access (or its actual exported entrypoint), never inserts Access rows.
 * All subsequent provisioning, approvals, operator sessions, scopes and grants use
 * real production lifecycle/Auth/Access commands, with durable approval/receipt bindings.
 * No provisioning sets, approval maps, invented approval tokens, token signer/mock,
 * service token, verifier replacement, parallel Actor/evaluator or seeded outcome SQL.
 * issue performs actual Auth issuance/consent for the registered ordinary OAuth client.
 * resources observes owned DB namespaces, servers, pools and workflow hosts, not counters.
 * Namespace/migrations/setup remain outside cost measurement. Real API growth capture
 * (including nested Auth/Access/receipts) and complete bulk/media/routes integration
 * belong to the existing imports-api suite, with shared GrowthDatabase instrumentation.
 */
import type { AccessAccount } from '@rezics/auth';
import type { Account } from '../services/kernel/src/access/account-data.ts';
import type { GrantInput } from '../services/kernel/src/access/grant-commands.ts';
import type { Envelope } from '../services/kernel/src/events/log.ts';
import type { Resource } from '../services/kernel/src/request/access.ts';
import type {
  ImportCredential,
  ImportIdentity,
  ImportIdentityOptions,
} from '../services/kernel/test/imports/identity-fixture.ts';
export { MISSING_IMPORT_IDENTITY } from '../services/kernel/test/imports/identity-fixture.ts';

export const GLOBAL: Readonly<Resource> = { route: 0, id: '00000000-0000-8000-0000-000000000000' };
export const SEMANTIC_ACTIONS = ['subject:create', 'source_fence:read', 'media:import_from_url'] as const;
export const BULK_ACTION = 'subject:batch_write';
export type Stage = 'auth-registration' | 'bootstrap' | 'grants';
export interface BootstrapEvidence {
  /** Exact durable one-time marker on Global's partition, read independently of CLI output. */
  marker: { partition: Envelope['partition']; resource: Resource; accountId: string; transactionId: string };
  /** Bootstrap-installed rows only, resolved by its exact persisted receipt/marker. */
  roles: readonly { resource: Resource; accountId: string; role: string }[];
  /** Actual bootstrap outbox plus native payload projection; never CLI text or expected data. */
  audit: readonly { envelope: Envelope; resource: Resource; accountId: string; transactionId: string }[];
}
export interface ImportIdentityDriver {
  open(options: {
    clock: ImportIdentityOptions['clock'];
    afterStage?: (stage: Stage) => Promise<void>;
  }): Promise<ImportIdentity>;
  /** Native readAccount and createAuthBindings.readAccount queries, on this fixture's DB. */
  account(fixture: ImportIdentity, accountId: string): Promise<Account | null>;
  authAccount(fixture: ImportIdentity, accountId: string): Promise<AccessAccount | null>;
  issue(fixture: ImportIdentity, accountId: string, scopes: readonly string[]): Promise<ImportCredential>;
  bootstrap(fixture: ImportIdentity, accountId: string): Promise<{ exitCode: number }>;
  bootstrapEvidence(fixture: ImportIdentity): Promise<BootstrapEvidence>;
  grants(fixture: ImportIdentity, accountId: string): Promise<readonly Pick<GrantInput, 'resource' | 'actions'>[]>;
  resources(): Promise<readonly string[]>;
  release(fixture: ImportIdentity): Promise<void>;
  close(): Promise<void>;
}
