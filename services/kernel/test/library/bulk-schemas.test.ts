import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { bulkAdmissionSchema, bulkCancelSchema, bulkOutcomeQuerySchema } from '../../src/library/bulk-schemas.ts';
test('bulk HTTP schemas distinguish subjects occurrences and exact full type predicates', () => {
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const query = {
    action: 'set_status',
    state: 'completed',
    selection: { kind: 'query', filter: { state: 'planned', primaryType: 'schema:' + 'A'.repeat(8192) } },
  };
  expect(Value.Check(bulkAdmissionSchema, query)).toBe(true);
  expect(Value.Check(bulkAdmissionSchema, { ...query, actor: id })).toBe(false);
  expect(Value.Check(bulkAdmissionSchema, { ...query, selection: { kind: 'query', filter: { typeKey: id } } })).toBe(
    false,
  );
  expect(
    Value.Check(bulkAdmissionSchema, {
      action: 'remove_from_collection',
      collectionId: id,
      selection: { kind: 'occurrences', memberIds: [id] },
    }),
  ).toBe(true);
  expect(
    Value.Check(bulkAdmissionSchema, {
      action: 'add_to_collection',
      collectionId: id,
      selection: { kind: 'occurrences', memberIds: [id] },
    }),
  ).toBe(false);
  expect(
    Value.Check(bulkAdmissionSchema, { action: 'remove_from_library', selection: { kind: 'explicit', targets: [] } }),
  ).toBe(false);
  expect(Value.Check(bulkCancelSchema, {})).toBe(true);
  expect(Value.Check(bulkCancelSchema, { undo: true })).toBe(false);
  expect(Value.Check(bulkOutcomeQuerySchema, { limit: 20 })).toBe(true);
  expect(Value.Check(bulkOutcomeQuerySchema, { limit: 21 })).toBe(false);
});
