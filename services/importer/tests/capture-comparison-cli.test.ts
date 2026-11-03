import { expect, test } from 'bun:test';
import { parseCaptureComparisonArgs, runCaptureComparisonCli } from '../src/capture-comparison-cli.ts';

test('capture-comparison help is self-contained and rejects every import-only option', async () => {
  expect(parseCaptureComparisonArgs(['--help'])).toBe('help');
  expect(() =>
    parseCaptureComparisonArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--before',
      '1',
      '--after',
      '2',
      '--account-key',
      'account.key',
    ]),
  ).toThrow('Unknown, import-only or repeated capture-comparison flag');
  expect(() =>
    parseCaptureComparisonArgs(['--state', 'state.sqlite', '--source', 'wikidata', '--before', '1', '--after', '2', '--limit', '20']),
  ).toThrow('--limit requires --page');
  expect(() =>
    parseCaptureComparisonArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--before',
      '1',
      '--after',
      '2',
      '--page',
      'changed',
      '--limit',
      '020',
    ]),
  ).toThrow('integer from 1 through 100');
  expect(() =>
    parseCaptureComparisonArgs([
      '--state',
      'state.sqlite',
      '--source',
      'wikidata',
      '--before',
      '9007199254740993',
      '--after',
      '2',
    ]),
  ).toThrow('positive stored generation ID');
  const help = await runCaptureComparisonCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and read-only');
  expect(help.stdout).toContain('--counts');
  expect(help.openHandles).toBe(0);
});
