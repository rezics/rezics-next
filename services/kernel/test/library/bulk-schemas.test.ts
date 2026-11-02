import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from '../../src/library/bulk-limits.ts';
import {
  bulkAdmissionSchema,
  bulkPreviewSchema,
  bulkCancelSchema,
  bulkOutcomeQuerySchema,
} from '../../src/library/bulk-schemas.ts';
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
  const add = {
    action: 'add_to_collection',
    collectionId: id,
    selection: { kind: 'explicit', targets: [{ subjectId: id }] },
  };
  expect(Value.Check(bulkPreviewSchema, add)).toBe(true);
  expect(Value.Check(bulkPreviewSchema, { ...add, actor: id })).toBe(false);
  expect(Value.Check(bulkPreviewSchema, { ...add, selection: { kind: 'explicit', targets: [] } })).toBe(false);
});

test('bulk admission accepts up to 1,000 UUID targets within the finite body bound', () => {
  const ids = Array.from(
    { length: BULK_MAX_SELECTION_IDS },
    (_, i) => `019a1b2c-3d4e-7f00-8a00-${String(i).padStart(12, '0')}`,
  );
  const explicit = {
    action: 'remove_from_library',
    selection: { kind: 'explicit', targets: ids.map((subjectId) => ({ subjectId })) },
  };
  const occurrences = {
    action: 'remove_from_collection',
    collectionId: ids[0],
    selection: { kind: 'occurrences', memberIds: ids },
  };

  expect(Value.Check(bulkAdmissionSchema, explicit)).toBe(true);
  expect(Value.Check(bulkAdmissionSchema, occurrences)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(explicit)).byteLength).toBeLessThanOrEqual(BULK_ADMISSION_BODY_BYTES);
  expect(
    Value.Check(bulkAdmissionSchema, {
      ...explicit,
      selection: { kind: 'explicit', targets: [...explicit.selection.targets, { subjectId: ids[0] }] },
    }),
  ).toBe(false);
});
