import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertCrossMediaEntity, vndbStaffNameLimit } from '../src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';

const subjectId = '00000000-0000-4000-8000-000000000004';
const preferred = { id: 's4', aid: '10', name: 'Preferred Alias' };
const additional = { id: 's4', aid: '20', name: 'Later Alias' };
const third = { id: 's4', aid: '30', name: 'Zeta Alias' };

function record(aliases: { id: string; aid: string; name: string }[], main: string | undefined = '10') {
  return {
    id: 's4',
    gender: null,
    lang: 'ja',
    ...(main === undefined ? {} : { main }),
    description: '',
    prod: null,
    aliases,
  };
}

function convert(body: object, bound = true) {
  return convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: body },
    bound ? { source: 'vndb', subjectId } : { source: 'vndb' },
    { converterRevision: converter_revision, sourceKind: 'vndb' },
  );
}

function names(result: { proposals: readonly BatchCommand[] }) {
  return result.proposals.flatMap((command) =>
    command.op === 'propose' &&
    command.statement.property.id === 'schema:name' &&
    command.statement.value.type === 'value'
      ? [command.statement.value.content]
      : [],
  );
}

test('preferred alias not last supplies the label and every admitted source name', () => {
  const bound = convert(record([preferred, additional, third]));
  const bootstrap = convert(record([preferred, additional, third]), false);
  expect(converter_revision).toBe('cross-media-entities@12');
  expect(bootstrap.proposals[0]).toMatchObject({
    op: 'create',
    subject: { type: 'schema:Person', labels: { und: 'Preferred Alias' } },
  });
  expect(bound.normalizedRecord).toEqual({
    id: 's4',
    name: 'Preferred Alias',
    main: '10',
    aliases: [preferred, additional, third],
  });
  expect(names(bound)).toEqual([
    { language: 'und', text: 'Preferred Alias' },
    { language: 'und', text: 'Later Alias' },
    { language: 'und', text: 'Zeta Alias' },
  ]);
  expect(bound.diagnostics).toEqual([]);
  expect(
    bound.proposals
      .filter((command) => command.op === 'propose')
      .every(
        (command) =>
          command.statement.references?.[0]?.parts[0]?.value.type === 'value' &&
          command.statement.references[0].parts[0].value.content === 'https://vndb.org/s4',
      ),
  ).toBe(true);
  const shuffled = convert(record([third, preferred, additional]));
  expect(shuffled.digest).toBe(bound.digest);
  expect(shuffled.proposals.map((command) => command.key)).toEqual(bound.proposals.map((command) => command.key));
  expect(names(shuffled)).toEqual(names(bound));
  const registration = createSourceRegistration('vndb', {
    source: 'vndb_cross_media',
    converterRevision: converter_revision,
  });
  expect(
    names(
      registration.convert(
        { external_id: 's4', record_revision: null, record: record([third, additional, preferred]) },
        { source: registration.source, subjectId },
      ),
    ),
  ).toEqual(names(bound));
});

test('preferred alias is the exact aid of this owner, never spelling or another person', () => {
  const spelling = convert(
    record([
      { id: 's4', aid: '20', name: 'Preferred Alias' },
      { id: 's4', aid: '10', name: 'Other Alias' },
    ]),
  );
  expect(spelling.normalizedRecord.name).toBe('Other Alias');
  expect(names(spelling)[0]).toEqual({ language: 'und', text: 'Other Alias' });
  expect(() => convert(record([preferred, { id: 's9', aid: '30', name: 'Preferred Alias' }]))).toThrow(ConversionError);
  const missing = convert(record([additional], '99'));
  expect(missing.diagnostics).toEqual([{ pointer: '/main', code: 'missing_preferred_alias' }]);
  expect(missing.normalizedRecord.name).toBe('s4');
  expect(names(missing)).toEqual([{ language: 'und', text: 'Later Alias' }]);
  const absent = convert({ id: 's4', main: null, aliases: [additional] });
  expect(absent.diagnostics).toEqual([{ pointer: '/main', code: 'missing_preferred_alias' }]);
  expect(names(absent)).toEqual([{ language: 'und', text: 'Later Alias' }]);
  const unselected = convert(record([additional], '0'));
  expect(unselected.normalizedRecord.main).toBe('0');
  expect(unselected.diagnostics).toEqual([{ pointer: '/main', code: 'missing_preferred_alias' }]);
  expect(names(unselected)).toEqual([{ language: 'und', text: 'Later Alias' }]);
  const scalar = convert({ id: 's4', name: 'Last row name' });
  expect(scalar.normalizedRecord).toEqual({ id: 's4', name: 'Last row name' });
  expect(names(scalar)).toEqual([{ language: 'und', text: 'Last row name' }]);
  const sealed = convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: { id: 's4', name: 'Last row name' } },
    { source: 'vndb', subjectId },
    { converterRevision: 'cross-media-entities@3', sourceKind: 'vndb' },
  );
  expect(sealed.proposals[0]?.source.converter_revision).toBe('cross-media-entities@3');
  expect(convert(record([additional, preferred])).proposals.map((command) => command.key)).not.toEqual(
    sealed.proposals.map((command) => command.key),
  );
  expect(convert(record([{ ...additional, name: 'Changed' }, preferred])).digest).not.toBe(
    convert(record([additional, preferred])).digest,
  );
});

test('malformed, duplicate and oversized aliases are rejected projections', () => {
  expect(() => convert(record([preferred, { ...preferred }]))).toThrow(ConversionError);
  expect(() => convert(record([preferred, { ...preferred, name: 'Other' }]))).toThrow(ConversionError);
  expect(() => convert({ id: 's4', main: 10, aliases: [preferred] })).toThrow(ConversionError);
  expect(() => convert({ id: 's4', main: '10', aliases: [{ ...preferred, aid: 10 }] })).toThrow(ConversionError);
  expect(() => convert({ id: 's4', main: '10', aliases: [{ aid: '10', name: 'Preferred Alias' }] })).toThrow(
    ConversionError,
  );
  const accessorAliases: unknown[] = [];
  Object.defineProperty(accessorAliases, '0', { enumerable: true, get: () => ({ ...preferred }) });
  try {
    convert({ id: 's4', main: '10', aliases: accessorAliases });
    throw new Error('expected accessor row to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionError);
    expect((error as ConversionError).pointer).toBe('/aliases/0');
  }
  expect(() =>
    convert({
      id: 's4',
      main: '10',
      aliases: Array.from({ length: vndbStaffNameLimit + 1 }, (_, i) => ({
        id: 's4',
        aid: String(i + 1),
        name: `N${i}`,
      })),
    }),
  ).toThrow(ConversionError);
  try {
    convert({ id: 's4', main: '10', aliases: [{ ...preferred, name: 'x'.repeat(501) }] });
    throw new Error('expected oversized name to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionError);
    expect((error as ConversionError).pointer).toBe('/aliases/0/name');
  }
});
