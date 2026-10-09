import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { writeAudit } from '../../services/account/src/operators.ts';
import { grantFixtureAuthority } from '../../services/main/src/modules/access/fixture-authority.ts';
import { AccessPlatformAdministrators } from '../../services/main/src/modules/access/platform-administrator.ts';
import { SeedApi, type SeedEndpoints } from '../dev/seed/api.ts';
import { atomicJson, repository, sha256 } from './store.ts';

const REASON =
  'Human-authorized local dataset administrator bootstrap; source and native data imports continue through HTTP APIs';
export interface DatasetAdminCredentials {
  email: string;
  password: string;
  name: string;
  id?: string;
  stackMarker?: string;
}
export interface DatasetAdminSetup {
  credentials: DatasetAdminCredentials;
  credentialsPath: string;
}
export const DATASET_ADMIN_GRANTS = [
  { action: 'work.create', scope: 'work:create:root' },
  { action: 'work.create', scope: 'work:create:catalogue-import' },
  { action: 'catalogue.verify', scope: 'catalogue:verify:root' },
  { action: 'semantic.change', scope: 'semantic:create:root' },
  { action: 'semantic.change.bulk', scope: 'semantic:create:root' },
] as const;

export function datasetAdminPath(account: string, marker?: string): string {
  return join(
    repository,
    '.temp/datasets',
    `administrator-${sha256(marker ? `${account}:${marker}` : account)}.json`,
  );
}
export function checkedLocalDatabase(value: string): string {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port
  ) {
    throw new Error(
      'Dataset administrator setup accepts explicitly ported loopback PostgreSQL databases only',
    );
  }
  return value;
}
function environment(stack: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(stack, 'dev.env'), 'utf8')
      .split('\n')
      .flatMap((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) return [];
        const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
        return [[match[1]!, value]];
      }),
  );
}
export function datasetStackMarker(epoch: string | undefined, operator: string): string {
  if (!epoch || !/^[0-9a-f-]{36}$/.test(epoch) || !operator || /[\s\u0000-\u001f]/.test(operator))
    throw new Error(
      'Dataset administrator requires the local stack epoch and operator identity reset marker',
    );
  return sha256(`${epoch}:${operator}`);
}
export function loadDatasetAdminCredentials(account: string, marker?: string): DatasetAdminSetup {
  const credentialsPath = datasetAdminPath(account, marker);
  let credentials: DatasetAdminCredentials;
  if (existsSync(credentialsPath)) {
    chmodSync(credentialsPath, 0o600);
    credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')) as DatasetAdminCredentials;
    if (marker && credentials.stackMarker !== marker)
      throw new Error(
        'Dataset administrator credentials belong to another local stack reset marker',
      );
    if (
      !credentials.email.endsWith('@example.test') ||
      !credentials.password ||
      credentials.name !== 'Local dataset administrator'
    ) {
      throw new Error(
        'Dataset administrator credentials do not belong to the dedicated local fixture',
      );
    }
  } else {
    credentials = {
      name: 'Local dataset administrator',
      email: `rezics-datasets-${randomBytes(12).toString('hex')}@example.test`,
      password: randomBytes(32).toString('base64url'),
    };
    // Persist before account creation, including an ambiguous sign-up response.
    if (marker) credentials.stackMarker = marker;
    atomicJson(credentialsPath, credentials);
  }
  return { credentials, credentialsPath };
}

/** Account creation/verification and role assignment use existing public APIs. */
export async function ensureDatasetAdminAccount(
  stack: string,
  endpoints: SeedEndpoints,
): Promise<DatasetAdminSetup> {
  for (const value of [
    endpoints.main,
    endpoints.account,
    endpoints.accountService ?? endpoints.account,
  ]) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname))
      throw new Error('Dataset administrator setup is local-only');
  }
  const env = environment(stack);
  const owner = (
    JSON.parse(readFileSync(join(stack, 'web-auth/private.json'), 'utf8')) as {
      operator?: { id: string; email: string; password: string };
    }
  ).operator;
  if (!owner) throw new Error('Dataset Account setup needs the existing local Account owner');
  const marker = datasetStackMarker(env.MAIN_DATA_EPOCH, owner.id);
  const path = datasetAdminPath(endpoints.account, marker),
    legacy = datasetAdminPath(endpoints.account);
  const api = new SeedApi(endpoints);
  // Adopt the initial pre-marker fixture only after public authentication proves
  // its exact Account still exists. Mark that legacy file once; later resets get
  // independent credentials and preserve every previous epoch's files.
  if (!existsSync(path) && existsSync(legacy)) {
    const previous = JSON.parse(readFileSync(legacy, 'utf8')) as DatasetAdminCredentials;
    if (!previous.stackMarker && previous.id) {
      try {
        const checked = await api.signInOrUp({
          email: previous.email,
          password: previous.password,
        });
        if (checked.id === previous.id) {
          previous.stackMarker = marker;
          atomicJson(legacy, previous);
          atomicJson(path, previous);
        }
      } catch {
        /* an absent/reset old Account is never recreated from old credentials */
      }
    }
  }
  const setup = loadDatasetAdminCredentials(endpoints.account, marker);
  const signed = await api.signInOrUp(setup.credentials);
  if (setup.credentials.id && setup.credentials.id !== signed.id) {
    throw new Error(
      'Dedicated dataset administrator Account identity changed; inspect the local stack before continuing',
    );
  }
  setup.credentials.id = signed.id;
  atomicJson(setup.credentialsPath, setup.credentials);
  const service = endpoints.accountService ?? endpoints.account;
  const status = await fetch(`${service}/api/account/admin/me`, {
    headers: { cookie: signed.cookie, origin: endpoints.account },
  });
  if (!status.ok) throw new Error(`Dataset administrator role read: HTTP ${status.status}`);
  const current = (await status.json()) as { role: string | null };
  if (current.role === 'admin' || current.role === 'owner') return setup;
  const signedOwner = await api.signInOrUp({ email: owner.email, password: owner.password });
  if (signedOwner.id !== owner.id) throw new Error('Local Account owner identity changed');
  const assigned = await fetch(
    `${service}/api/account/admin/operators/${encodeURIComponent(signed.id)}`,
    {
      method: 'POST',
      headers: {
        cookie: signedOwner.cookie,
        origin: endpoints.account,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'admin', reason: REASON }),
    },
  );
  if (!assigned.ok)
    throw new Error(
      `Public dataset administrator Account role assignment: HTTP ${assigned.status}`,
    );
  await assigned.body?.cancel();
  return setup;
}

/** Narrow fixture-only setup; every caller must retain the existing recovery/authority fences. */
export async function grantDatasetAdminAuthority(
  client: Pick<PoolClient, 'query'>,
  issuer: string,
  accountSubject: string,
  actor: string,
) {
  if (
    !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actor) ||
    !accountSubject ||
    accountSubject.length > 256
  ) {
    throw new Error('Dataset administrator authority identity is invalid');
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `dataset-admin:${issuer}:${accountSubject}`,
    ]);
    const principal = (
      await client.query<{ id: string; active: boolean }>(
        'SELECT id, active FROM access.principal WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE',
        [issuer, accountSubject],
      )
    ).rows[0];
    if (!principal?.active)
      throw new Error(
        'Dataset administrator needs its publicly provisioned active Access principal',
      );
    const control = await client.query(
      'SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > clock_timestamp() FOR SHARE',
      [principal.id, actor, 'agent.control'],
    );
    if (!control.rowCount)
      throw new Error('Dataset administrator must already control its publicly provisioned Agent');
    const granted: { action: string; scope: string; id: string }[] = [];
    for (const { action, scope } of DATASET_ADMIN_GRANTS) {
      const authority = await grantFixtureAuthority(client, {
        scope,
        requireDispatch: true,
        refuseExistingPolicy: true,
        representations: [{ principalId: principal.id, actor, action, lifetime: '7 days' }],
        grant: { actor, action, lifetime: '7 days', requireSelfIssuer: true },
      });
      granted.push({ id: authority.grantId, action, scope });
    }
    await client.query('COMMIT');
    return { principal: principal.id, granted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Cross-owner setup is complete only once its Account audit has succeeded. */
export async function completeDatasetAdminAudit(
  path: string,
  completed: unknown,
  audit: () => Promise<void>,
): Promise<void> {
  await audit();
  atomicJson(path, completed);
}

/** This is the only owner-store bypass, explicitly authorized for the dedicated local administrator. */
export async function ensureDatasetAdminAccess(
  stack: string,
  accountSubject: string,
  actor: string,
): Promise<void> {
  const env = environment(stack);
  const access = new Pool({ connectionString: checkedLocalDatabase(env.ACCESS_DATABASE_URL!) });
  const account = new Pool({ connectionString: checkedLocalDatabase(env.ACCOUNT_DATABASE_URL!) });
  const issuer = env.ACCOUNT_ISSUER ?? `${env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL}/api/auth`;
  const receiptPath = join(
    repository,
    '.temp/datasets',
    `administrator-authority-${sha256(`${issuer}:${accountSubject}:${actor}`)}.json`,
  );
  atomicJson(receiptPath, {
    format: 'rezics-local-dataset-admin-v1',
    reason: REASON,
    state: 'attempted',
    accountSubject,
    actor,
    grants: DATASET_ADMIN_GRANTS,
  });
  try {
    // The owner command is immutable and ignores a pre-existing designation.
    // It never replaces or modifies another administrator.
    const designation = await new AccessPlatformAdministrators(access).designateFirst(
      issuer,
      accountSubject,
      () => {},
    );
    const client = await access.connect();
    let result;
    try {
      result = await grantDatasetAdminAuthority(client, issuer, accountSubject, actor);
    } finally {
      client.release();
    }
    const completed = {
      format: 'rezics-local-dataset-admin-v1',
      reason: REASON,
      state: 'completed',
      accountSubject,
      actor,
      designation,
      ...result,
      completedAt: new Date().toISOString(),
    };
    await completeDatasetAdminAudit(receiptPath, completed, () =>
      writeAudit(account, {
        actorId: accountSubject,
        action: 'local_dataset_authority_bootstrapped',
        targetId: actor,
        reason: REASON,
        before: null,
        after: { designation, grants: result.granted },
        requestId: randomUUID(),
      }),
    );
  } finally {
    await Promise.allSettled([access.end(), account.end()]);
  }
}

export async function bootstrapDatasetAdmin(
  stack = process.env.REZICS_DATASET_STACK ?? join(repository, '.temp/stack/rezics-dev'),
) {
  const { localDatasetSession } = await import('./auth.ts');
  const session = await localDatasetSession(stack, 'admin');
  const env = environment(stack);
  return {
    mainOrigin: session.mainOrigin,
    actingSubject: session.actingSubject,
    credentialsPath: datasetAdminPath(
      env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!,
      datasetStackMarker(
        env.MAIN_DATA_EPOCH,
        (
          JSON.parse(readFileSync(join(stack, 'web-auth/private.json'), 'utf8')) as {
            operator: { id: string };
          }
        ).operator.id,
      ),
    ),
    reason: REASON,
    scope: 'Dedicated local administrator only; all dataset content writes use HTTP',
  };
}

export interface DatasetBulkOwnerStatus {
  state: 'cancelled' | 'succeeded' | 'unknown';
  admission: string | null;
  receipt: string | null;
  dataEpoch: string | null;
  stageCount: number;
}
/** Read-only recovery for a public bulk API that reports a sealed cancellation as202.
 * The same Account/Actor and local epoch must own the immutable terminal proof.
 * It never changes admissions, source data, graph resources, or private stages. */
export async function inspectDatasetBulkOwnerStatus(
  stack: string,
  accountSubject: string,
  actor: string,
  key: string,
): Promise<DatasetBulkOwnerStatus> {
  const env = environment(stack),
    issuer = env.ACCOUNT_ISSUER ?? `${env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL}/api/auth`;
  const access = new Pool({
    connectionString: checkedLocalDatabase(env.ACCESS_DATABASE_URL!),
    options: '-c default_transaction_read_only=on',
  });
  const content = new Pool({
    connectionString: checkedLocalDatabase(env.CONTENT_DATABASE_URL!),
    options: '-c default_transaction_read_only=on',
  });
  try {
    const rows = (
      await access.query<{
        id: string;
        state: string;
        graph_outcome: string | null;
        graph_receipt: string | null;
        graph_data_epoch: string | null;
      }>(
        `SELECT a.id,a.state,a.graph_outcome,a.graph_receipt,a.graph_data_epoch FROM access.admission a
       JOIN access.principal p ON p.id=a.principal_id
       WHERE p.account_issuer=$1 AND p.account_subject=$2 AND a.acting_subject=$3
         AND a.action='semantic.change.bulk' AND a.idempotency_key=$4 LIMIT 2`,
        [issuer, accountSubject, actor, key],
      )
    ).rows;
    if (rows.length !== 1)
      return { state: 'unknown', admission: null, receipt: null, dataEpoch: null, stageCount: 0 };
    const row = rows[0]!;
    const stages = (
      await content.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM semantic.change_stage WHERE admission_id=$1',
        [row.id],
      )
    ).rows[0];
    const valid =
      row.state === 'sealed' &&
      row.graph_data_epoch === env.MAIN_DATA_EPOCH &&
      /^urn:rezics:receipt:[a-f0-9]{64}$/.test(row.graph_receipt ?? '');
    return {
      state:
        valid && row.graph_outcome === 'cancelled'
          ? 'cancelled'
          : valid && row.graph_outcome === 'succeeded'
            ? 'succeeded'
            : 'unknown',
      admission: row.id,
      receipt: row.graph_receipt,
      dataEpoch: row.graph_data_epoch,
      stageCount: Number(stages?.count ?? 0),
    };
  } finally {
    await Promise.allSettled([access.end(), content.end()]);
  }
}
