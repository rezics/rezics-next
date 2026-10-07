import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BootstrapApiError, type BootstrapApi } from './api.ts';
import type { BootstrapJournal } from './journal.ts';

/** The only permission bootstrap grants. It opens source intake and the other
 * catalogue-import routes for this principal; it is not platform:grant. */
export const CATALOGUE_IMPORT_PERMISSION = 'platform:use:catalogue-import';

/** At most four grant-page reads (50 episodes each) and one grant write.
 * A stale authority epoch discards that unconfirmed command, reads the page
 * again and writes once more; it does not keep writing. A fresh designation
 * is about twenty-five episodes. A longer history stops instead of scanning
 * every past episode. No database connection. */
export const CATALOGUE_IMPORT_GRANT_COST = Object.freeze({ pages: 4, writes: 2 });

const principalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const authorityEpochPattern = /^(0|[1-9][0-9]*)$/;

export interface BootstrapOperator {
  /** Account issuer from the bearer token. It is the designation receipt's issuer. */
  issuer: string;
  /** Account subject. The command checks it against the launch plan. */
  accountSubject: string;
  /** Person Agent that issues the grant and is the launch plan's actor. */
  actor: string;
}

interface PlatformGrantView {
  permission: string;
  scopeId: string;
  receipt: string;
  active: boolean;
  validUntil: string | null;
  principalId?: string;
}

export class CatalogueImportGrantMissing extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `Bootstrap principal lacks ${CATALOGUE_IMPORT_PERMISSION}: ${detail}`
        : `Bootstrap principal lacks ${CATALOGUE_IMPORT_PERMISSION}`,
    );
  }
}

/** The public grant page returns this receipt on the first administrator's
 * seeded episodes. It identifies that principal without an Access query. */
export function firstAdministratorReceipt(issuer: string, accountSubject: string): string {
  return `urn:rezics:access-receipt:${createHash('sha256')
    .update(JSON.stringify(['platform-first-administrator-v1', issuer, accountSubject]))
    .digest('hex')}`;
}

function grantFailure(error: unknown, action: 'read' | 'grant'): never {
  if (error instanceof BootstrapApiError) {
    const verb = action === 'read' ? 'read platform grants for' : 'grant';
    throw new Error(
      `Bootstrap cannot ${verb} ${CATALOGUE_IMPORT_PERMISSION}: HTTP ${error.status} (${error.code})`,
    );
  }
  throw error;
}

function readGrant(value: unknown): PlatformGrantView | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const recipient = row.recipient;
  if (
    typeof row.permission !== 'string' ||
    typeof row.scopeId !== 'string' ||
    typeof row.receipt !== 'string' ||
    typeof row.active !== 'boolean' ||
    (row.validUntil !== null && typeof row.validUntil !== 'string') ||
    !recipient ||
    typeof recipient !== 'object'
  ) {
    return null;
  }
  const principalId = (recipient as { principalId?: unknown }).principalId;
  if (principalId !== undefined && (typeof principalId !== 'string' || !principalIdPattern.test(principalId))) {
    return null;
  }
  return {
    permission: row.permission,
    scopeId: row.scopeId,
    receipt: row.receipt,
    active: row.active,
    validUntil: row.validUntil as string | null,
    ...(typeof principalId === 'string' ? { principalId } : {}),
  };
}

export async function readPlatformGrants(
  api: BootstrapApi,
  actor: string,
): Promise<{ authorityEpoch: string; grants: PlatformGrantView[] }> {
  const grants: PlatformGrantView[] = [];
  let after: string | undefined;
  let authorityEpoch = '';
  for (let page = 0; page < CATALOGUE_IMPORT_GRANT_COST.pages; page++) {
    const query = new URLSearchParams({ issuerSubject: actor, profile: 'platform-grants-v1' });
    if (after) query.set('after', after);
    let body: unknown;
    try {
      body = await api.read<unknown>(`/v1/access/grants?${query}`);
    } catch (error) {
      grantFailure(error, 'read');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      (body as { profile?: unknown }).profile !== 'platform-grants-v1' ||
      !Array.isArray((body as { grants?: unknown }).grants) ||
      typeof (body as { authorityEpoch?: unknown }).authorityEpoch !== 'string'
    ) {
      throw new Error('Bootstrap did not receive a platform grant page');
    }
    const parsed = body as { authorityEpoch: string; grants: unknown[]; nextCursor?: unknown };
    authorityEpoch = parsed.authorityEpoch;
    for (const row of parsed.grants) {
      const grant = readGrant(row);
      if (grant) grants.push(grant);
    }
    const cursor = parsed.nextCursor;
    if (cursor === null || cursor === undefined) return { authorityEpoch, grants };
    if (typeof cursor !== 'string' || cursor === after) {
      throw new Error('Bootstrap platform grant page did not advance');
    }
    after = cursor;
  }
  throw new Error('Bootstrap platform grant page exceeded its read bound');
}

export function bootstrapPrincipalId(grants: readonly PlatformGrantView[], receipt: string): string {
  const principalId = grants.find((grant) => grant.receipt === receipt && grant.principalId)?.principalId;
  if (!principalId) {
    throw new CatalogueImportGrantMissing('first platform administrator designation is absent');
  }
  return principalId;
}

export function holdsCatalogueImport(
  grants: readonly PlatformGrantView[],
  principalId: string,
  now = Date.now(),
): boolean {
  return grants.some((grant) => {
    if (
      !grant.active ||
      grant.permission !== CATALOGUE_IMPORT_PERMISSION ||
      grant.scopeId !== 'platform:access' ||
      grant.principalId !== principalId
    ) {
      return false;
    }
    if (grant.validUntil === null) return true;
    const until = Date.parse(grant.validUntil);
    return Number.isFinite(until) && until > now;
  });
}

function grantChange(actor: string, authorityEpoch: string, principalId: string) {
  if (!authorityEpochPattern.test(authorityEpoch)) {
    throw new Error('Bootstrap platform grant page has no authority epoch');
  }
  return {
    profile: 'platform-grant-change-v1' as const,
    issuerSubject: actor,
    expectedAuthorityEpoch: authorityEpoch,
    action: 'create' as const,
    grantId: randomUUID(),
    permission: CATALOGUE_IMPORT_PERMISSION,
    recipient: { principalId },
    validUntil: null,
  };
}

/** Grant catalogue import when this principal does not already hold it.
 * A journaled grant is not issued again; verification reports it missing
 * after revocation, before source intake. */
export async function ensureCatalogueImportGrant(input: {
  api: BootstrapApi;
  journal: BootstrapJournal;
  namespace: string;
  operator: BootstrapOperator;
}): Promise<void> {
  const { api, journal, namespace, operator } = input;
  const key = `bootstrap:${namespace}:catalogue-import`;
  const page = await readPlatformGrants(api, operator.actor);
  const principalId = bootstrapPrincipalId(
    page.grants,
    firstAdministratorReceipt(operator.issuer, operator.accountSubject),
  );
  const saved = journal.state.entries[key];
  if (holdsCatalogueImport(page.grants, principalId)) return;
  if (saved?.response !== undefined) throw new CatalogueImportGrantMissing();
  const intent = { permission: CATALOGUE_IMPORT_PERMISSION, principalId };
  const body = saved?.body ?? grantChange(operator.actor, page.authorityEpoch, principalId);
  try {
    await journal.command(api, key, 'POST', '/v1/access/grant-changes', body, intent);
  } catch (error) {
    // The epoch is read before the write. A lost race did not create the grant;
    // drop the unconfirmed command and send one new body with the current epoch.
    const pending = journal.state.entries[key];
    if (
      !(error instanceof BootstrapApiError) ||
      error.code !== 'grant_stale' ||
      pending?.response !== undefined
    ) {
      grantFailure(error, 'grant');
    }
    delete journal.state.entries[key];
    const fresh = await readPlatformGrants(api, operator.actor);
    try {
      await journal.command(
        api,
        key,
        'POST',
        '/v1/access/grant-changes',
        grantChange(operator.actor, fresh.authorityEpoch, principalId),
        intent,
      );
    } catch (retryError) {
      grantFailure(retryError, 'grant');
    }
  }
}

export async function assertCatalogueImportGrant(
  api: BootstrapApi,
  operator: BootstrapOperator,
): Promise<void> {
  const page = await readPlatformGrants(api, operator.actor);
  const principalId = bootstrapPrincipalId(
    page.grants,
    firstAdministratorReceipt(operator.issuer, operator.accountSubject),
  );
  if (!holdsCatalogueImport(page.grants, principalId)) throw new CatalogueImportGrantMissing();
}

export interface GovernanceCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function redactGovernanceOutput(text: string): string {
  return text
    .replace(/\b(?:postgres|postgresql):\/\/\S+/gi, '[database]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]');
}

export function platformGovernanceCommand(envFile: string): [string, ...string[]] {
  return ['task', 'ops:platform-governance', '--', envFile];
}

async function runPlatformGovernance(envFile: string): Promise<GovernanceCommandResult> {
  const [program, ...args] = platformGovernanceCommand(envFile);
  const proc = Bun.spawn([program, ...args], {
    cwd: resolve(import.meta.dir, '../../..'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function verifyPlatformGovernance(
  envFile: string,
  run: (envFile: string) => Promise<GovernanceCommandResult> = runPlatformGovernance,
): Promise<void> {
  const result = await run(envFile);
  if (result.code === 0) return;
  const detail = redactGovernanceOutput(`${result.stderr}\n${result.stdout}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  throw new Error(
    detail ? `Platform governance verification failed: ${detail}` : 'Platform governance verification failed',
  );
}

/** Production verification runs platform governance. QA mode has no production
 * environment file; that command refuses a development database URL. */
export async function verifyProductionOpening(
  production: boolean,
  envFile: string | undefined,
  governance: (envFile: string) => Promise<void> = verifyPlatformGovernance,
): Promise<void> {
  if (!production) return;
  if (!envFile) throw new Error('Production bootstrap verification requires --env');
  await governance(envFile);
}
