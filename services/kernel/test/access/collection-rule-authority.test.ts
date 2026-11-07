import { expect, test } from 'bun:test';
import { createNativeCollectionRuleAccountAuthority } from '../../src/access/adapters/collection-rule-authority.ts';
import { AccessWorkAccounting, AccessWorkUnavailableError, type AccessWork } from '../../src/access/work.ts';
import {
  registerCommandWorkAssociation,
  withCommandWorkAssociation,
  type CommandWorkAssociation,
} from '../../src/command/work-context.ts';

const accountId = '12340000-0000-8000-8000-000000000001';
const floor = '9223372036854775807';
const authority = createNativeCollectionRuleAccountAuthority();

test('command-state capability preserves original client, key, private state and bigint floor, including absence', async () => {
  for (const row of [
    null,
    { kind: 'actor', state: 'active', fenced: false, minimumAuthnEpoch: floor },
    { kind: 'actor', state: 'suspended', fenced: true, minimumAuthnEpoch: '2' },
    { kind: 'organization', state: 'deleted', fenced: true, minimumAuthnEpoch: floor },
  ]) {
    const client = {
      async query(this: unknown, text: string, values: unknown[]) {
        expect(this).toBe(client);
        expect(text).toContain('FROM access.account');
        expect(text).toContain('authn_fenced AS fenced');
        expect(values).toEqual([0x1234, accountId]);
        return { rows: row ? [row] : [], fields: [] };
      },
    };
    expect(await authority.readAccount(client, 0x1234, accountId)).toEqual(
      row ? { ...row, minimumAuthnEpoch: BigInt(row.minimumAuthnEpoch) } : null,
    );
  }
});

test('the command-state producer reserves on the current Access ledger before dispatch and preserves failures', async () => {
  for (const mode of ['present', 'absent', 'refused', 'failed'] as const) {
    const reservations: string[] = [];
    const settled: AccessWork[] = [];
    let dispatched = false;
    const failure = new Error('command-state query failed');
    const access = new AccessWorkAccounting(
      {
        reserve(operation) {
          reservations.push(operation);
          return mode === 'refused' ? null : { settle: (actual) => settled.push(actual) };
        },
      },
      Date.now() + 10_000,
    );
    const unexpected = () => {
      throw new Error('command-state producer must use the existing Access ledger');
    };
    const association: CommandWorkAssociation = {
      access,
      deadline: access.deadline,
      reserve: unexpected,
      run: unexpected,
      receipt: unexpected,
      close: () => undefined,
    };
    registerCommandWorkAssociation(association);
    const client = {
      async query() {
        dispatched = true;
        expect(reservations).toEqual(['access.account-state']);
        if (mode === 'failed') throw failure;
        return {
          rows: mode === 'present' ? [{ kind: 'actor', state: 'active', fenced: false, minimumAuthnEpoch: floor }] : [],
          fields: [],
        };
      },
    };
    const read = () => withCommandWorkAssociation(association, () => authority.readAccount(client, 0x1234, accountId));
    if (mode === 'refused') {
      await expect(read()).rejects.toBeInstanceOf(AccessWorkUnavailableError());
      expect(dispatched).toBe(false);
      expect(settled).toEqual([]);
    } else if (mode === 'failed') {
      await expect(read()).rejects.toBe(failure);
      expect(settled).toHaveLength(1);
    } else {
      expect(await read()).toEqual(
        mode === 'present' ? { kind: 'actor', state: 'active', fenced: false, minimumAuthnEpoch: BigInt(floor) } : null,
      );
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ keys: 1, points: 1, rows: 2, emptySeeks: mode === 'absent' ? 1 : 0 });
      expect(settled[0]!.bytes).toBeGreaterThan(0);
    }
  }
});
