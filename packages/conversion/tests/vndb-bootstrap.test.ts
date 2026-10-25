import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import record from '../../../specs/fixtures/imports/vndb/record.json';
import { convertVndb, converter_revision } from '../src/vndb';

test('vndb bootstrap has metadata only and resolved statements are tracked proposals', () => {
  const input = { external_id: record.vn.id, record_revision: String(record.entry_meta.revision), record };
  const bootstrap = convertVndb(input);
  expect(bootstrap.proposals).toHaveLength(1);
  const claim = bootstrap.proposals[0]!;
  expect(claim.op).toBe('create');
  if (claim.op !== 'create') throw new Error('Expected claim');
  expect(claim.subject).not.toHaveProperty('statements');
  expect(Object.keys(claim.subject).every((k) => ['type', 'labels', 'descriptions', 'aliases'].includes(k))).toBe(true);
  expect(checkBatchWrite({ commands: bootstrap.proposals })).toEqual([]);
  expect(claim.source.converter_revision).toBe(converter_revision);
  const subjectId = '00000000-0000-4000-8000-000000000001';
  const resolved = convertVndb(input, { subjectId });
  expect(resolved.proposals.length).toBeGreaterThan(0);
  expect(resolved.proposals.every((c) => c.op === 'propose' && c.subject === subjectId)).toBe(true);
  expect(resolved.digest).toBe(bootstrap.digest);
  expect(checkBatchWrite({ commands: resolved.proposals })).toEqual([]);
  expect(resolved.proposals.some((c) => c.op === 'propose' && c.statement.property.id === 'schema:name')).toBe(true);
});
