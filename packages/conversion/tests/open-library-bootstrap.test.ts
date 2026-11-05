import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import work from '../../../specs/fixtures/imports/open-library/work.json';
import edition from '../../../specs/fixtures/imports/open-library/edition.json';
import { convertOpenLibrary, converter_revision } from '../src/open-library.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const authorId = '00000000-0000-4000-8000-000000000002';

for (const [record, subjectType] of [
  [work, 'schema:Book'],
  [edition, 'bf:Instance'],
] as const) {
  test(`open-library ${subjectType} bootstrap replays as metadata only before native binding`, () => {
    const input = { external_id: record.key, record_revision: String(record.revision), record };
    const bootstrap = convertOpenLibrary(input);
    expect(bootstrap.proposals).toHaveLength(1);
    const claim = bootstrap.proposals[0]!;
    expect(claim.op).toBe('create');
    if (claim.op !== 'create') throw new Error('Expected bootstrap claim');
    expect(claim.subject).toEqual({ type: subjectType, labels: { und: record.title } });
    expect(claim.source.converter_revision).toBe(converter_revision);
    expect(claim.source.record_revision).toBe(String(record.revision));
    expect(checkBatchWrite({ commands: bootstrap.proposals })).toEqual([]);
    expect(convertOpenLibrary(input)).toEqual(bootstrap);
    expect(convertOpenLibrary(input, { resolvedReferences: { '/authors/OL900000001A': authorId } })).toEqual(bootstrap);
    expect(convertOpenLibrary({ ...input, record: bootstrap.normalizedRecord })).toEqual(bootstrap);

    const bound = convertOpenLibrary(input, {
      subjectId,
      resolvedReferences: { '/authors/OL900000001A': authorId },
    });
    expect(bound.digest).toBe(bootstrap.digest);
    expect(bound.record_revision).toBe(bootstrap.record_revision);
    expect(bound.proposals.length).toBeGreaterThan(0);
    expect(bound.proposals.every((command) => command.op === 'propose' && command.subject === subjectId)).toBe(true);
    expect(checkBatchWrite({ commands: bound.proposals })).toEqual([]);
    const author = bound.proposals.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:author',
    );
    if (!author || author.op !== 'propose') throw new Error('Expected author proposal');
    expect(author.statement.value).toEqual({ type: 'value', content: authorId });
    expect(author.key).not.toBe(claim.key);
  });
}

test('edition work bindings change only the affected proposal identity', () => {
  const input = { external_id: edition.key, record_revision: String(edition.revision), record: edition };
  const outputs = [undefined, authorId, '00000000-0000-4000-8000-000000000003'].map((workId) =>
    convertOpenLibrary(input, {
      subjectId,
      resolvedReferences: workId ? { '/works/OL900000001W': workId } : {},
    }),
  );
  const baseline = outputs[0]!;
  const keys = new Set<string>();
  for (const output of outputs) {
    expect(output.digest).toBe(baseline.digest);
    expect(output.proposals).toHaveLength(baseline.proposals.length);
    for (let i = 0; i < output.proposals.length; i++) {
      const command = output.proposals[i]!;
      if (command.op === 'propose' && command.statement.property.id === 'schema:exampleOfWork') {
        keys.add(command.key);
        expect(command.statement.qualifiers).toEqual([
          { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL900000001W' } },
        ]);
      } else expect(command).toEqual(baseline.proposals[i]!);
    }
  }
  expect(keys.size).toBe(3);
});
