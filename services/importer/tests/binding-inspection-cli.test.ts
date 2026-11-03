import { expect, test } from 'bun:test';
import { parseBindingInspectionArgs, runBindingInspectionCli } from '../src/binding-inspection-cli.ts';

test('binding inspection help is self-contained and rejects import-only options', async () => {
  expect(parseBindingInspectionArgs(['--help'])).toBe('help');
  expect(() =>
    parseBindingInspectionArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--record',
      'Q42',
      '--account-key',
      'account.key',
    ]),
  ).toThrow('Unknown, import-only or repeated inspection flag');
  expect(() =>
    parseBindingInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--record', 'Q42', '--limit', '20']),
  ).toThrow('--limit requires --page');
  expect(() =>
    parseBindingInspectionArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--record',
      'Q42',
      '--page',
      'semantic',
      '--limit',
      '020',
    ]),
  ).toThrow('integer from 1 through 100');
  expect(() =>
    parseBindingInspectionArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--record',
      'Q42',
      '--page',
      'pending',
    ]),
  ).toThrow('semantic, candidates, media or metadata');
  const help = await runBindingInspectionCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and read-only');
  expect(help.stdout).toContain('inspect-bindings');
  expect(help.openHandles).toBe(0);
});
