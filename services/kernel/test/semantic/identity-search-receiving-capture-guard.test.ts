import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  prepareSearchReceivingCaptures,
  searchReceivingCaptureStatements as sql,
} from '../../src/semantic/identity-search-receiving-capture.ts';

type Role = { account_id: string; role: string };
const original = '00000000-0000-4000-8000-000000000001';
const native = '00000000-0000-4000-8000-000000000002';
const account = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

// An explicit planner unit double, not a transaction/provenance or original-frame
// funding fixture. The separate native regression requires real command origins.
function planner(copies: Role[], originalRoles: Role[], nativeRoles: Role[]) {
  let selected = false;
  let armed = 0;
  let nativeRows = 0;
  const reserved: WorkDimensions[] = [];
  const next = (rows: Role[], values: readonly unknown[], offset: number) => {
    const previous =
      values[offset] === undefined
        ? -1
        : rows.findIndex((row) => row.account_id === values[offset] && row.role === values[offset + 1]);
    if (values[offset] !== undefined && previous === -1) throw new Error('Unknown planner continuation');
    return rows.slice(previous + 1, previous + 2);
  };
  const client = {
    async query(text: string, values: readonly unknown[]) {
      if (text === sql.next) {
        if (selected) return { rows: [] };
        selected = true;
        return {
          rows: [
            {
              ordinal: '1',
              partition_no: 1,
              store: 'identity_epoch_effect_receipt',
              record_key: '1',
              source_transaction_id: original,
              native_transaction_id: native,
            },
          ],
        };
      }
      if (text === sql.copyFirst || text === sql.copyNext) return { rows: next(copies, values, 4) };
      if (text === sql.sourceFirst || text === sql.sourceNext) {
        const rows = next(values[1] === original ? originalRoles : nativeRoles, values, 2);
        if (values[1] === native) nativeRows += rows.length;
        return { rows };
      }
      if (text === sql.basis) return { rows: [] };
      if (text === sql.arm) {
        armed++;
        return { rows: [{ ordinal: '1' }], rowCount: 1 };
      }
      throw new Error('Unexpected capture-planner SQL');
    },
  } as unknown as PoolClient;
  return {
    run: () => prepareSearchReceivingCaptures(client, (cost) => reserved.push(cost)),
    reserved,
    armed: () => armed,
    nativeRows: () => nativeRows,
  };
}

test('conflicting provenance beyond eight roles refuses before arming without refunding reached work', async () => {
  const same = { account_id: account, role: 'author' };
  const roles = Array.from({ length: 16 }, (_, index) => ({
    account_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    role: 'author',
  }));
  const p = planner([], [same], [...roles, same]);
  await expect(p.run()).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
    message:
      'Search receiving capture unavailable provenance: shared locator cannot retain distinct transaction origins',
  });
  expect(p.nativeRows()).toBe(17);
  expect(p.armed()).toBe(0);
  // Admission of a deferred role footprint remains retained even when this
  // representation guard subsequently refuses the affected deferred dispatch.
  expect(p.reserved.some((cost) => cost.nativePoints > 0)).toBe(true);
  expect(p.reserved.some((cost) => cost.nativePoints === 0 && cost.bytes > 0)).toBe(true);
});

test('same-origin copies and distinct legal native roles still reach arming', async () => {
  const same = { account_id: account, role: 'author' };
  const p = planner([same], [same], [{ account_id: account, role: 'owner' }]);
  await p.run();
  expect(p.armed()).toBe(1);
  expect(p.nativeRows()).toBe(1);
});
