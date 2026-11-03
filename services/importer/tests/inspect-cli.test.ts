import { expect, test } from 'bun:test';
import { parseInspectionArgs, runInspectCli } from '../src/inspect-cli.ts';

test('inspection help is self-contained and rejects every import-only option', async () => {
  expect(parseInspectionArgs(['--help'])).toBe('help');
  expect(() =>
    parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--account-key', 'account.key']),
  ).toThrow('Unknown, import-only or repeated inspection flag');
  expect(() =>
    parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--limit', '20']),
  ).toThrow('--limit requires --page');
  expect(() =>
    parseInspectionArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--page', 'pending', '--limit', '020']),
  ).toThrow('integer from 1 through 100');
  const help = await runInspectCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and read-only');
  expect(help.openHandles).toBe(0);
});
