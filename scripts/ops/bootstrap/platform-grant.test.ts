import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { BootstrapApiError, type BootstrapApi } from './api.ts';
import { executeBootstrap, verifyBootstrap, type BootstrapResult } from './execute.ts';
import { BootstrapJournal, digest } from './journal.ts';
import { loadPlan, type BootstrapPlan, type ZoneManifest } from './plan.ts';
import {
  CATALOGUE_IMPORT_PERMISSION,
  ensureCatalogueImportGrant,
  firstAdministratorReceipt,
  platformGovernanceCommand,
  verifyPlatformGovernance,
  verifyProductionOpening,
  type BootstrapOperator,
} from './platform-grant.ts';

const root = resolve(import.meta.dir, '../../..');
const actor = 'https://rezics.com/id/00000000-0000-4000-a000-000000000001';
const issuer = 'https://account.example/api/auth';
const accountSubject = 'launch-operator';
const principalId = '00000000-0000-4000-a000-000000000002';
const operator = (): BootstrapOperator => ({ issuer, accountSubject, actor });

interface GrantRow {
  permission: string;
  scopeId: string;
  receipt: string;
  active: boolean;
  validUntil: string | null;
  recipient: { principalId: string };
}

function designation(): GrantRow {
  return {
    permission: 'platform:grant',
    scopeId: 'platform:access',
    receipt: firstAdministratorReceipt(issuer, accountSubject),
    active: true,
    validUntil: null,
    recipient: { principalId },
  };
}

function catalogue(active = true, validUntil: string | null = null): GrantRow {
  return {
    permission: CATALOGUE_IMPORT_PERMISSION,
    scopeId: 'platform:access',
    receipt: `urn:rezics:access-receipt:${'ab'.repeat(32)}`,
    active,
    validUntil,
    recipient: { principalId },
  };
}

/** The public grant page. Its rows are `items`, the same name as platform-grants-v1. */
function page(rows: GrantRow[], nextCursor: string | null = null) {
  return {
    profile: 'platform-grants-v1',
    authorityEpoch: '3',
    items: rows,
    nextCursor,
    complete: nextCursor === null,
  };
}

async function harness(initial: GrantRow[], paged = false) {
  const loaded = await loadPlan(root, 'tests/fixtures/launch/plan.yaml', false);
  const plan: BootstrapPlan = loaded.plan;
  const zones: ZoneManifest[] = loaded.zones;
  plan.namespace = `grant-${crypto.randomUUID().slice(0, 8)}`;
  plan.operators[0]!.accountSubject = accountSubject;
  plan.operators[0]!.actingSubject = actor;
  const journal = new BootstrapJournal(
    {
      profile: 'launch-bootstrap-journal-v1',
      planDigest: digest({ plan, zones }),
      actor,
      entries: {},
    },
    async () => {},
  );
  let grants = initial;
  const writes: { path: string; body: unknown; key: string }[] = [];
  const api: BootstrapApi = {
    async read<T>(path: string): Promise<T> {
      const url = new URL(path, 'https://main.example');
      if (url.pathname === '/v1/types') {
        return {
          profile: 'types-v1',
          digest: 'c'.repeat(64),
          types: [{ type: 'https://schema.org/VideoGame', base: 'work' }],
        } as T;
      }
      if (url.pathname === '/v1/access/grants') {
        if (paged && url.searchParams.get('after') !== 'page-1') {
          return page(
            [
              {
                permission: 'platform:use:platform-admin',
                scopeId: 'platform:access',
                receipt: `urn:rezics:access-receipt:${'cd'.repeat(32)}`,
                active: true,
                validUntil: null,
                recipient: { principalId },
              },
            ],
            'page-1',
          ) as T;
        }
        return page(grants) as T;
      }
      throw new Error(`unexpected read ${url.pathname}`);
    },
    async write<T>(method: 'POST' | 'PUT', path: string, body: unknown, key: string): Promise<T> {
      writes.push({ path, body, key });
      if (path === '/v1/access/grant-changes') {
        grants = [...grants.filter((grant) => grant.permission !== CATALOGUE_IMPORT_PERMISSION), catalogue()];
        const grantId = (body as { grantId?: string }).grantId;
        return { authorityEpoch: '4', grant: { id: grantId } } as T;
      }
      throw new Error('bootstrap continued');
    },
  };
  return {
    root,
    plan,
    zones,
    journal,
    api,
    writes,
    replaceGrants: (next: GrantRow[]) => {
      grants = next;
    },
  };
}

test('a fresh catalogue bootstrap grants catalogue import once and continues', async () => {
  const h = await harness([designation()]);
  await expect(
    executeBootstrap({ ...h, operator: operator() }),
  ).rejects.toThrow('bootstrap continued');
  const grants = h.writes.filter((write) => write.path === '/v1/access/grant-changes');
  expect(grants).toHaveLength(1);
  expect(grants[0]!.key).toBe(`bootstrap:${h.plan.namespace}:catalogue-import`);
  expect(grants[0]!.body).toMatchObject({
    profile: 'platform-grant-change-v1',
    action: 'create',
    permission: CATALOGUE_IMPORT_PERMISSION,
    issuerSubject: actor,
    expectedAuthorityEpoch: '3',
    recipient: { principalId },
    validUntil: null,
  });
  expect(Object.keys(grants[0]!.body as object).sort()).toEqual([
    'action',
    'expectedAuthorityEpoch',
    'grantId',
    'issuerSubject',
    'permission',
    'profile',
    'recipient',
    'validUntil',
  ]);
  h.writes.length = 0;
  await expect(executeBootstrap({ ...h, operator: operator() })).rejects.toThrow('bootstrap continued');
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(0);
  expect(h.writes.length).toBeGreaterThan(0);
});

test('a re-run grants nothing new when catalogue import is already held', async () => {
  const h = await harness([designation(), catalogue()]);
  await expect(executeBootstrap({ ...h, operator: operator() })).rejects.toThrow('bootstrap continued');
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(0);
  h.writes.length = 0;
  await expect(executeBootstrap({ ...h, operator: operator() })).rejects.toThrow('bootstrap continued');
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(0);
});

test('a revoked catalogue-import grant fails verification by name before intake', async () => {
  const h = await harness([designation()]);
  await expect(executeBootstrap({ ...h, operator: operator() })).rejects.toThrow('bootstrap continued');
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(1);
  h.replaceGrants([designation(), catalogue(false)]);
  h.writes.length = 0;
  await expect(executeBootstrap({ ...h, operator: operator() })).rejects.toThrow(
    `Bootstrap principal lacks ${CATALOGUE_IMPORT_PERMISSION}`,
  );
  expect(h.writes.some((write) => write.path === '/v1/sources/intakes')).toBe(false);
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(0);
  await expect(verifyBootstrap(h.api, {} as BootstrapResult, h.zones, operator())).rejects.toThrow(
    `Bootstrap principal lacks ${CATALOGUE_IMPORT_PERMISSION}`,
  );
});

test('a lost grant response retries the same catalogue-import command', async () => {
  const h = await harness([designation()]);
  let lose = true;
  const bodies: unknown[] = [];
  h.api.write = async <T>(_method: 'POST' | 'PUT', path: string, body: unknown, key: string): Promise<T> => {
    expect(path).toBe('/v1/access/grant-changes');
    expect(key).toBe(`bootstrap:${h.plan.namespace}:catalogue-import`);
    bodies.push(structuredClone(body));
    if (lose) {
      lose = false;
      throw new Error('lost response');
    }
    return { authorityEpoch: '4' } as T;
  };
  await expect(
    ensureCatalogueImportGrant({ api: h.api, journal: h.journal, namespace: h.plan.namespace, operator: operator() }),
  ).rejects.toThrow('lost response');
  await ensureCatalogueImportGrant({
    api: h.api,
    journal: h.journal,
    namespace: h.plan.namespace,
    operator: operator(),
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  h.replaceGrants([designation(), catalogue()]);
  await ensureCatalogueImportGrant({
    api: h.api,
    journal: h.journal,
    namespace: h.plan.namespace,
    operator: operator(),
  });
  expect(bodies).toHaveLength(2);
});

test('an expired catalogue-import grant is issued again', async () => {
  const h = await harness([designation(), catalogue(true, '2000-01-01T00:00:00.000Z')]);
  await expect(
    ensureCatalogueImportGrant({ api: h.api, journal: h.journal, namespace: h.plan.namespace, operator: operator() }),
  ).resolves.toBeUndefined();
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(1);
});

test('a platform grant page whose rows are named grants is refused', async () => {
  const h = await harness([designation()]);
  h.api.read = async <T>(path: string): Promise<T> => {
    const url = new URL(path, 'https://main.example');
    if (url.pathname !== '/v1/access/grants') throw new Error(`unexpected read ${url.pathname}`);
    return {
      profile: 'platform-grants-v1',
      authorityEpoch: '3',
      grants: [designation()],
      nextCursor: null,
      complete: true,
    } as T;
  };
  await expect(
    ensureCatalogueImportGrant({
      api: h.api,
      journal: h.journal,
      namespace: h.plan.namespace,
      operator: operator(),
    }),
  ).rejects.toThrow('Bootstrap did not receive a platform grant page');
});

test('the designation grant is read from a later page', async () => {
  const h = await harness([designation(), catalogue(false)], true);
  await expect(
    ensureCatalogueImportGrant({ api: h.api, journal: h.journal, namespace: h.plan.namespace, operator: operator() }),
  ).resolves.toBeUndefined();
  expect(h.writes.filter((write) => write.path === '/v1/access/grant-changes')).toHaveLength(1);
});

test('a stale grant epoch is retried once with the current epoch', async () => {
  const h = await harness([designation()]);
  let epoch = '3';
  const epochs: string[] = [];
  h.api.read = async <T>(path: string): Promise<T> => {
    const url = new URL(path, 'https://main.example');
    if (url.pathname !== '/v1/access/grants') throw new Error(`unexpected read ${url.pathname}`);
    return page([designation()], null) as T;
  };
  const original = h.api.read;
  h.api.read = async <T>(path: string): Promise<T> => {
    const body = await original<{ authorityEpoch: string }>(path);
    return { ...body, authorityEpoch: epoch } as T;
  };
  h.api.write = async <T>(_method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> => {
    const submitted = body as { expectedAuthorityEpoch: string };
    epochs.push(submitted.expectedAuthorityEpoch);
    if (epochs.length === 1) {
      epoch = '4';
      throw new BootstrapApiError(409, 'grant_stale', path);
    }
    return { authorityEpoch: epoch } as T;
  };
  await ensureCatalogueImportGrant({
    api: h.api,
    journal: h.journal,
    namespace: h.plan.namespace,
    operator: operator(),
  });
  expect(epochs).toEqual(['3', '4']);
  expect(h.journal.state.entries[`bootstrap:${h.plan.namespace}:catalogue-import`]!.response).toBeDefined();
});

test('a denied grant names catalogue import', async () => {
  const h = await harness([designation()]);
  h.api.write = async () => {
    throw new BootstrapApiError(403, 'grant_denied', '/v1/access/grant-changes');
  };
  await expect(
    ensureCatalogueImportGrant({ api: h.api, journal: h.journal, namespace: h.plan.namespace, operator: operator() }),
  ).rejects.toThrow(
    `Bootstrap cannot grant ${CATALOGUE_IMPORT_PERMISSION}: HTTP 403 (grant_denied)`,
  );
});

test('platform governance failure fails verification and hides database URLs', async () => {
  expect(platformGovernanceCommand('.temp/production.env')).toEqual([
    'task',
    'ops:platform-governance',
    '--',
    '.temp/production.env',
  ]);
  const calls: string[] = [];
  await verifyProductionOpening(false, undefined, async (envFile) => {
    calls.push(envFile);
  });
  expect(calls).toEqual([]);
  await expect(verifyProductionOpening(true, undefined, async () => {})).rejects.toThrow('--env');
  await verifyProductionOpening(true, '.temp/production.env', async (envFile) => {
    calls.push(envFile);
  });
  expect(calls).toEqual(['.temp/production.env']);
  await expect(
    verifyPlatformGovernance('.temp/production.env', async () => ({
      code: 1,
      stdout: '',
      stderr: 'Production opening requires an active principal with a permanent platform:grant',
    })),
  ).rejects.toThrow('platform:grant');
  try {
    await verifyPlatformGovernance('.temp/production.env', async () => ({
      code: 1,
      stdout: '',
      stderr: 'connect postgres://operator:secret@db.internal/access failed',
    }));
    throw new Error('expected governance failure');
  } catch (error) {
    expect(String(error)).toContain('[database]');
    expect(String(error)).not.toContain('secret');
    expect(String(error)).toContain('Platform governance verification failed');
  }
  await expect(
    verifyPlatformGovernance('.temp/production.env', async () => ({ code: 0, stdout: 'verified', stderr: '' })),
  ).resolves.toBeUndefined();
});
