import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import type { LibraryProfile, Release } from '@rezics/definitions';
import { declareBound } from '@rezics/bounds';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { createNativeCopyPorts } from '../../src/library/adapters/copies.ts';
import { createCopyOperationPlans } from '../../src/library/copy-operation-bounds.ts';
import {
  bindCopyCommandOperation,
  consumeCopyCommandAttempt,
  executeCopyOperation,
  executeCopyStatementWork,
} from '../../src/library/copy-operation-runtime.ts';
import {
  registerCommandWorkAssociation,
  withCommandWorkAssociation,
  type CommandWorkAssociation,
} from '../../src/command/work-context.ts';
import { bindLibraryAccess, requireLibraryAccess } from '../../src/library/domain-binding.ts';
import type { LibraryAccessPorts } from '../../src/library/access-port.ts';
import type { CopyOperationWork } from '../../src/library/contract/index.ts';
import type { NativeCopyProducers } from '../../src/library/copy-model.ts';
import type { Copy } from '../../src/library/entry-model.ts';

const owner: AccountActor = {
  kind: 'account',
  accountId: '00000000-0000-7000-8000-112200000001',
  clientId: 'copy-construction',
  scopes: ['copy:read', 'copy:list'],
  requestedBy: null,
  authnEpoch: 1,
};
const pin = (digit: string) => ({
  provenance: 'profile' as const,
  releaseDigest: `sha256:${digit.repeat(64)}`,
  acceptingType: 'ex:Edition',
  profileId: 'holdings',
});
const kindPin = pin('1');
const statusPin = pin('2');
const conditionPin = pin('3');
const currentPin = pin('4');
const profile: LibraryProfile = {
  id: 'holdings',
  copies: {
    kinds: [
      {
        id: 'physical',
        labels: { en: 'Printed edition' },
        condition: 'physical-v1',
        statuses: [{ id: 'owned', labels: { en: 'Owned' } }],
      },
    ],
  },
};
function release(value: LibraryProfile): Release {
  return {
    types: { 'ex:Edition': { library: { profileId: 'holdings' } } },
    libraryProfiles: { holdings: value },
  } as unknown as Release;
}
const copy: Copy = {
  id: '00000000-0000-7000-8000-112200000003',
  accountId: owner.accountId,
  subjectId: '00000000-0000-7000-8000-112200000002',
  kind: 'physical',
  status: 'owned',
  location: null,
  source: null,
  acquiredOn: null,
  disposedOn: null,
  note: null,
  revision: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  transactionId: 'transaction',
  conditionFacts: {
    mediaCondition: { value: 'mint', pin: conditionPin, kindId: 'physical' },
    packagingCondition: { value: null, pin: conditionPin, kindId: 'physical' },
  },
};
const zero = declareBound({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  engineRequests: 0,
});
function work(calls: string[]): CopyOperationWork {
  const leaf =
    (name: string) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return zero;
    };
  return {
    account: { floor: leaf('floor'), share: leaf('share'), command: leaf('command') },
    sessionPartitionWork: leaf('partition'),
    sessionProfileMigrationWork: leaf('migration'),
    sessionReadTimeWork: leaf('time'),
    sessionReleaseWork: leaf('release'),
    sessionShelfWork: leaf('shelf'),
    sessionSourceWork: leaf('source'),
  };
}

// Keep the native deadline wrapping seam inert: these tests assert which original resources reach each capability.
async function withDeadlinePort(body: () => Promise<void>) {
  const previous = requireLibraryAccess();
  bindLibraryAccess({ ...previous, deadlineClient: (client: unknown) => client } as LibraryAccessPorts);
  try {
    await body();
  } finally {
    bindLibraryAccess(previous);
  }
}

test('native detail, source, inventory and owner reads retain the supplied producers and original resources', async () => {
  await withDeadlinePort(async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
      release: () => {
        calls.push('release-client');
      },
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const access = {} as Access;
    const at = {} as AuthoritativeTime;
    const deadline = 123456;
    const anchor = {
      subjectId: copy.subjectId,
      requestedSubjectId: null,
      acceptingType: 'ex:Edition',
      identityEpoch: 7n,
      component: { partition: 1, epoch: 2, position: 3n },
    };
    let currentAnchor: typeof anchor | null = anchor;
    const currentProfile = structuredClone(profile);
    currentProfile.copies!.kinds[0]!.labels = { en: 'Current edition name' };
    currentProfile.copies!.kinds[0]!.statuses[0]!.labels = { en: 'Current owned label' };
    const source = {
      ...anchor,
      kind: 'supported' as const,
      profile: currentProfile,
      pin: currentPin,
    };
    let definitionsAvailable = true;
    let sourceAvailable = true;
    const definitions: NativeCopyProducers['definitions'] = {
      async read(resource, digest, options) {
        expect(resource === pool || resource === client).toBe(true);
        expect(options).toEqual({ composed: false });
        calls.push(`definition:${digest}`);
        expect([kindPin.releaseDigest, statusPin.releaseDigest, conditionPin.releaseDigest]).toContain(digest);
        return definitionsAvailable ? release(profile) : null;
      },
      async active() {
        throw new Error('Current source owns active-release resolution');
      },
    };
    const producers: NativeCopyProducers = {
      definitions,
      commands: {
        async ownAccountPrepared() {
          throw new Error('No command in a read');
        },
      },
      work: work(calls),
      account: {
        async admit(resource, actor) {
          expect(resource).toBe(client);
          expect(actor).toBe(owner);
          calls.push('admit-owner');
        },
        async check() {
          throw new Error('No detail observation in this test');
        },
        denied: () => new Error('denied'),
      },
      profileSource: {
        async observe(deps, subjectId) {
          expect(deps).toEqual({ pool, access, actor: owner, at, deadline });
          expect(subjectId).toBe(copy.subjectId);
          calls.push('observe-source');
          if (!sourceAvailable) throw new Error('Source unavailable');
          return { source, anchor };
        },
        async anchor(deps, subjectId) {
          expect(deps.pool).toBe(pool);
          expect(deps.at).toBe(at);
          expect(deps.deadline).toBe(deadline);
          expect(subjectId).toBe(copy.subjectId);
          return currentAnchor;
        },
      },
    };
    const ports = createNativeCopyPorts({ pool, access, tokens: { current: 1, keys: new Map() } }, producers);
    expect(await ports.source(owner, copy.subjectId, at, deadline)).toEqual({ source, anchor });
    const detail = await ports.presentation(
      owner,
      { copy, kindPin, statusPin, compatibilityPin: statusPin },
      at,
      deadline,
      ['en'],
    );
    expect(detail.presentation).toMatchObject({
      meaning: 'known',
      kindLabel: 'Printed edition',
      statusLabel: 'Owned',
      statusEditing: {
        state: 'supported',
        statuses: [{ id: 'owned', label: 'Current owned label', labelLanguage: 'en' }],
      },
      mediaCondition: { state: 'recorded', id: 'mint', label: 'Mint' },
      packagingCondition: { state: 'cleared' },
      conditionEditing: { state: 'supported', currentness: 'current' },
    });
    expect(detail.disclosure).toEqual({ subject: true });
    expect(calls.filter((call) => call.startsWith('definition:'))).toEqual([
      `definition:${kindPin.releaseDigest}`,
      `definition:${statusPin.releaseDigest}`,
      `definition:${conditionPin.releaseDigest}`,
    ]);
    await detail.verify(at);
    currentAnchor = { ...anchor, identityEpoch: 8n };
    await expect(detail.verify(at)).rejects.toMatchObject({ code: 'semantic_not_ready' });
    const inventory = await ports.inventory(
      [
        { dimension: 'kind', id: 'physical', copyId: copy.id, copyKind: 'physical', profilePin: kindPin },
        { dimension: 'status', id: 'owned', copyId: copy.id, copyKind: 'physical', profilePin: statusPin },
      ],
      deadline,
      ['en'],
    );
    expect(inventory.kinds.choices).toEqual([
      { id: 'physical', label: 'Printed edition', labelLanguage: 'en', meaning: 'available' },
    ]);
    expect(inventory.statuses.choices).toEqual([
      { id: 'owned', label: 'Owned', labelLanguage: 'en', meaning: 'available' },
    ]);
    await ports.gate(owner, deadline);
    await ports.readOnly(
      owner,
      async (resource) => {
        expect(resource).toBe(client);
      },
      deadline,
    );
    expect(calls.filter((call) => call === 'admit-owner')).toHaveLength(2);
    expect(calls).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls).toContain('COMMIT');
    expect(calls.filter((call) => call === 'release-client')).toHaveLength(4);
    definitionsAvailable = false;
    sourceAvailable = false;
    currentAnchor = null;
    const unavailable = await ports.presentation(
      owner,
      { copy, kindPin, statusPin, compatibilityPin: statusPin },
      at,
      deadline,
      ['en'],
    );
    expect(unavailable.presentation).toMatchObject({
      meaning: 'unavailable',
      mediaCondition: { state: 'unavailable' },
      conditionEditing: { state: 'unavailable', currentness: 'unavailable', reason: 'current_source_unavailable' },
    });
    expect(unavailable.disclosure).toEqual({ subject: false });
    await unavailable.verify(at);
  });
});

test('all copy operation plans consume supplied static work without executing native statements', () => {
  const calls: string[] = [];
  const plans = createCopyOperationPlans(work(calls));
  plans.gate(0x1122, owner.accountId);
  plans.read(0x1122, owner.accountId, copy.id);
  plans.presentation(0x1122, owner.accountId, copy.id, copy.subjectId);
  plans.inventory({
    route: 0x1122,
    accountId: owner.accountId,
    limit: 20,
    subjectId: null,
    kind: 'physical',
    status: 'owned',
    cursor: null,
  });
  for (const operation of ['create', 'update', 'delete', 'restore'] as const) {
    const plan = plans.mutation(operation, {
      route: 0x1122,
      accountId: owner.accountId,
      copyId: copy.id,
      subjectId: copy.subjectId,
      requestKey: 'same-receipt',
      receiptKeys: 2,
      clientId: owner.clientId,
      requestedBy: null,
      durationMs: 1000,
      commandInput: {},
    });
    expect(plan.input).toMatchObject({ accountId: owner.accountId, copyId: copy.id, requestKey: 'same-receipt' });
    expect(Object.isFrozen(plan)).toBe(true);
  }
  for (const leaf of ['floor', 'share', 'command', 'partition', 'migration', 'time', 'release', 'shelf', 'source'])
    expect(calls).toContain(leaf);
});

test('copy roots and retries retain one accounting frame without charging native leaves twice', async () => {
  const calls: string[] = [];
  const association: CommandWorkAssociation = {
    deadline: 123456,
    access: {} as CommandWorkAssociation['access'],
    reserve(operation) {
      calls.push(`reserve:${operation}`);
      return {
        settle() {
          calls.push('settle');
        },
      };
    },
    async run(operation, _bound, dispatch) {
      calls.push(`run:${operation}`);
      return dispatch();
    },
    receipt() {
      throw new Error('No receipt projection needed');
    },
    close() {
      return undefined;
    },
  };
  registerCommandWorkAssociation(association);
  const plan = createCopyOperationPlans(work([])).gate(0x1122, owner.accountId);
  await withCommandWorkAssociation(association, async () => {
    await executeCopyOperation(plan, () =>
      executeCopyOperation(plan, () =>
        executeCopyStatementWork('nested', zero, async () => {
          calls.push('read');
        }),
      ),
    );
    expect(calls).toEqual(['reserve:library.copy.account-gate.current-owner-floor', 'read', 'settle']);
    calls.length = 0;
    await bindCopyCommandOperation(plan, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await consumeCopyCommandAttempt(plan);
        await executeCopyStatementWork('nested', zero, async () => {
          calls.push('write');
        });
      }
    });
    expect(calls).toEqual([
      'run:library.copy.account-gate.current-owner-floor',
      'write',
      'run:library.copy.account-gate.current-owner-floor',
      'write',
    ]);
    calls.length = 0;
    const failure = new Error('native read failed');
    await expect(
      executeCopyOperation(plan, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual(['reserve:library.copy.account-gate.current-owner-floor', 'settle']);
  });
});
