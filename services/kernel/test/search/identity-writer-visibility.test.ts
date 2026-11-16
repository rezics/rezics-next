import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { validateSearchRepairWriterEvidence, type SearchRepairWriterReceipt } from '../../src/search/writer-guard.ts';

test('identity writer visibility requires an exact bulk item and refuses readback recovery', () => {
  const index = 'writer-visibility-subjects-g1';
  const partition = 0x841;
  const subject = newId(partition << 4);
  const document = {
    id: subject,
    partition,
    type: 'subject',
    security_revision: 1,
    names: [],
    descriptions: [],
    name_sort: null,
    statements: [],
    facts: [],
    credit_search_complete: false,
    credited_names: [],
  };
  const shards = { total: 1, successful: 1, failed: 0 };
  const enrollment = { partition, epoch: 1, position: 21n, transactionId: crypto.randomUUID() };
  const completion = { partition, epoch: 1, position: 22n, transactionId: crypto.randomUUID() };
  const receipt: SearchRepairWriterReceipt = {
    locator: crypto.randomUUID(),
    subject,
    partition,
    epoch: 1,
    incarnation: 'allocation',
    writeAlias: `${index}-writer-${'a'.repeat(32)}`,
    consumer: 'search_writer_visibility_subjects_g1',
    action: { op: 'index', id: subject, version: 20n, document },
    enrollment,
    completion,
    native: {
      evidence: {
        kind: 'recovered',
        current: { _index: index, _id: subject, _version: 20, _source: document, found: true },
        refresh: { _shards: shards },
      },
    },
  };
  const identity = { allowReadbackRecovery: false };
  expect(() => validateSearchRepairWriterEvidence(index, receipt)).not.toThrow();
  expect(() => validateSearchRepairWriterEvidence(index, receipt, identity)).toThrow();
  const item = {
    _index: index,
    _id: subject,
    _version: 20,
    _shards: shards,
    _seq_no: 1,
    _primary_term: 1,
    status: 201,
    result: 'created',
  };
  const retainedBulk = (indexItem: typeof item) => ({
    ...receipt,
    native: { evidence: { kind: 'bulk', bulk: { errors: false, items: [{ index: indexItem }] } } },
  });
  expect(() => validateSearchRepairWriterEvidence(index, retainedBulk(item), identity)).not.toThrow();
  expect(() => validateSearchRepairWriterEvidence(index, retainedBulk({ ...item, _version: 21 }), identity)).toThrow();
});
