import { expect, test } from 'bun:test';
import { createCopyApplication } from '../../src/library/application/index.ts';
import { CopyConflictError, CopyInvalidError } from '../../src/library/contract/index.ts';
import type { CopyApplicationPorts, CopyNativeTypes, LibraryAccountActor } from '../../src/library/contract/index.ts';
import { copyOperationPlan, parseCreate } from '../../src/library/core/index.ts';

const accountId = '00000000-0000-7000-8000-112200000001';
const subjectId = '00000000-0000-7000-8000-112200000002';
const copyId = '00000000-0000-7000-8000-112200000003';
const owner: LibraryAccountActor = {
  kind: 'account',
  accountId,
  clientId: 'copy-application',
  scopes: ['copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'],
  requestedBy: null,
  authnEpoch: 3,
};
type Copy = CopyNativeTypes['copy'];
type N = {
  transaction: { id: string };
  time: { witness: string };
  attempt: { time: { witness: string } };
  command: { transactionId: string; time: { witness: string } };
  outcome: { value: Copy };
  copy: Copy;
  fact: { copy: Copy };
  source: { subjectId: string } | null;
  observation: { subjectId: string } | null;
  retained: { subjectId: string };
  detail: { copy: Copy };
  presentation: { meaning: string };
  inventory: { kinds: string[] };
  inventoryValues: string[];
};

function fixture() {
  const calls: string[] = [];
  const copy: Copy = {
    id: copyId,
    accountId,
    subjectId,
    revision: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    status: 'owned',
    disposedOn: null,
  };
  const tx = { id: 'original-transaction' };
  const time = { witness: 'command-time' };
  const attempt = { time };
  const command = { transactionId: 'original-receipt', time };
  const plan = copyOperationPlan('test', 'retained', {}, []);
  let retained = { deletionId: '00000000-0000-0000-0000-000000000001', revision: 2, expired: false };
  const ports: CopyApplicationPorts<N> = {
    deadline: () => 9000,
    remaining: () => 1000,
    newId: () => copyId,
    requireRoute: () => 0x1122,
    sameAccountRoute: () => 0x1122,
    denied: () => new Error('denied'),
    notFound: () => new Error('missing'),
    problem: (code) => new Error(code),
    gate: async (actor, deadline) => {
      expect(actor).toBe(owner);
      expect(deadline).toBe(9000);
      calls.push('gate');
    },
    readOnly: async (_owner, body) => {
      calls.push('read-owner');
      return body(tx);
    },
    within: (_deadline, body) => body(),
    request: (_deadline, body) => body(),
    time: async () => time,
    releaseTime: (at) => {
      expect(at).toBe(time);
      calls.push('release-time');
    },
    receiptKeys: () => 2,
    async run(actor, spec, body) {
      expect(actor).toBe(owner);
      return spec.execution(async () => {
        const prepared = await spec.prepare(attempt, time);
        calls.push('receipt-miss');
        return body(tx, command, prepared);
      });
    },
    admitAttempt: async (actor, _action, current) => {
      expect(actor).toBe(owner);
      expect(current).toBe(attempt);
      calls.push('attempt');
    },
    plans: {
      gate: () => plan,
      mutation: () => plan,
      read: () => plan,
      presentation: () => plan,
      inventory: () => plan,
    },
    execute: async (_plan, body) => {
      calls.push('fund-read');
      return body();
    },
    bind: async (_plan, body) => {
      calls.push('bind-command');
      return body();
    },
    consume: async (value) => {
      expect(value).toBe(plan);
      calls.push('fund-attempt');
    },
    source: async (actor, id, at, deadline) => {
      expect(actor).toBe(owner);
      expect(id).toBe(subjectId);
      expect(at).toBe(time);
      expect(deadline).toBe(9000);
      calls.push('source');
      return { subjectId };
    },
    currentSource: (before, after) => {
      expect(before).toEqual(after);
      return after;
    },
    read: async () => copy,
    lock: async () => copy,
    fact: async () => ({ copy }),
    noOpenLoan: async () => {
      calls.push('loan');
    },
    insert: async (client, context) => {
      expect(client).toBe(tx);
      expect(context).toBe(command);
      calls.push('insert');
      return copy;
    },
    update: async () => copy,
    delete: async () => true,
    privateRead: async () => ({ subjectId }),
    validateRetained: async () => {
      calls.push('retained-meaning');
    },
    retention: async () => retained,
    restore: async () => {
      calls.push('restore');
      return true;
    },
    observeDetail: async () => {
      calls.push('detail-owner');
      return { fact: { copy }, epoch: 4 };
    },
    presentation: async () => ({
      presentation: { meaning: 'known' },
      disclosure: { subject: true },
      verify: async () => {
        calls.push('source-fence');
      },
    }),
    partition: async () => ({ epoch: 4 }),
    decodeCursor: () => ({ ok: true, epoch: 4, after: [copy.createdAt, copyId] }),
    encodeCursor: () => 'cursor',
    page: async () => [],
    inventoryValues: async () => ['owned'],
    inventory: async () => ({ kinds: ['physical'] }),
  };
  return {
    ports,
    calls,
    copy,
    tx,
    time,
    attempt,
    command,
    setRetention: (value: typeof retained) => {
      retained = value;
    },
  };
}

test('account admission precedes malformed mutation input and all receipt/source work', async () => {
  const { ports, calls } = fixture();
  const denied = new Error('native denied');
  ports.gate = async () => {
    calls.push('denied');
    throw denied;
  };
  await expect(createCopyApplication(ports).createCopy(owner, { unrelated: true }, 'key')).rejects.toBe(denied);
  expect(calls).toEqual(['fund-read', 'denied']);
  expect(() => parseCreate({ subjectId, acquiredOn: '2025-02-29' })).toThrow(CopyInvalidError);
  expect(parseCreate({ subjectId, acquiredOn: '2024-02-29' }).acquiredOn).toBe('2024-02-29');
});

test('fresh create funds its original native attempt before admission, observations and mutation', async () => {
  const { ports, calls, copy } = fixture();
  const result = await createCopyApplication(ports).createCopy(
    owner,
    { subjectId, kind: 'physical', status: 'owned' },
    'original-key',
  );
  expect(result.value).toBe(copy);
  expect(calls).toEqual([
    'fund-read',
    'gate',
    'bind-command',
    'fund-attempt',
    'attempt',
    'source',
    'source',
    'receipt-miss',
    'insert',
  ]);
});

test('an exact native receipt survives failed preparation without replacement attempt credentials', async () => {
  const { ports, calls, copy, attempt, time } = fixture();
  const receipt = { value: copy };
  ports.source = async () => {
    calls.push('unavailable-source');
    throw new Error('source unavailable');
  };
  ports.run = async (actor, spec) => {
    expect(actor).toBe(owner);
    await spec.execution(() => spec.prepare(attempt, time));
    calls.push('exact-receipt');
    return receipt;
  };
  await expect(createCopyApplication(ports).createCopy(owner, { subjectId }, 'retry-key')).resolves.toBe(receipt);
  expect(calls).toEqual([
    'fund-read',
    'gate',
    'bind-command',
    'fund-attempt',
    'attempt',
    'unavailable-source',
    'unavailable-source',
    'exact-receipt',
  ]);
});

test('detail rechecks owner authority after a source failure and releases both native times', async () => {
  const { ports, calls } = fixture();
  const failure = new Error('source moved');
  ports.presentation = async () => ({
    presentation: { meaning: 'known' },
    disclosure: { subject: true },
    verify: async () => {
      calls.push('source-fence');
      throw failure;
    },
  });
  await expect(createCopyApplication(ports).readPresentedCopy(owner, copyId)).rejects.toBe(failure);
  expect(calls).toEqual(['fund-read', 'detail-owner', 'source-fence', 'detail-owner', 'release-time', 'release-time']);
});

test('filtered maximum inventory uses one sentinel in each observation without refilling a sparse page', async () => {
  const { ports, calls, copy } = fixture();
  ports.page = async (_tx, _route, _account, page, subject, kind, status) => {
    expect([subject, kind, status]).toEqual([subjectId, 'physical', 'owned']);
    calls.push(`page:${page.limit}`);
    return page.limit === 1 ? [] : [copy];
  };
  ports.inventory = async () => {
    calls.push('inventory');
    return { kinds: ['physical'] };
  };
  const page = await createCopyApplication(ports).listCopiesWithObservation(owner, {
    limit: 100,
    subjectId,
    kind: 'physical',
    status: 'owned',
    cursor: 'cursor',
  });
  expect(page).toEqual({ copies: [copy], next: null, accountEpoch: 4, filterOptions: { kinds: ['physical'] } });
  expect(calls).toEqual([
    'fund-read',
    'read-owner',
    'page:100',
    'page:1',
    'inventory',
    'read-owner',
    'page:100',
    'page:1',
  ]);
});

test('restore terminal authority precedes deferred retained-meaning failure; delete guard remains a conflict', async () => {
  const { ports, calls, setRetention } = fixture();
  ports.validateRetained = async () => {
    throw new Error('retained meaning unavailable');
  };
  setRetention({ deletionId: '00000000-0000-0000-0000-000000000001', revision: 2, expired: true });
  const application = createCopyApplication(ports);
  await expect(
    application.restoreCopy(
      owner,
      copyId,
      { deletionId: '00000000-0000-0000-0000-000000000001', revision: 2 },
      'restore',
    ),
  ).rejects.toThrow('copy_restore_expired');
  expect(calls).not.toContain('restore');
  await expect(application.deleteCopy(owner, copyId, undefined, 'delete')).rejects.toBeInstanceOf(CopyConflictError);
});
