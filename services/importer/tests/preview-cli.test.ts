import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { parsePreviewArgs, runPreviewCli } from '../src/preview-cli.ts';

test('preview help is self-contained and rejects every import-only option', async () => {
  expect(parsePreviewArgs(['--help'])).toBe('help');
  expect(() =>
    parsePreviewArgs(['--source', 'wikidata', '--dump', 'dump.json', '--account-key', 'account.key']),
  ).toThrow('Unknown, import-only or repeated preview flag');
  expect(() => parsePreviewArgs(['--source', 'wikidata', '--dump', 'dump.json', '--limit', '20'])).toThrow(
    '--limit requires --page',
  );
  const help = await runPreviewCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and offline');
  expect(help.openHandles).toBe(0);
});

test('preview CLI decodes a dump without credentials, leases or network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-cli-'));
  try {
    const dump = join(directory, 'bangumi.jsonl');
    await writeFile(dump, await readFile(new URL('../../../specs/fixtures/imports/dumps/bangumi-subject.jsonlines', import.meta.url)));
    const output = join(directory, 'plan');
    const requests: string[] = [];
    const result = await runImportCli(
      ['preview', '--source', 'bangumi', '--dump', dump, '--output-dir', output, '--json', '--page', 'new', '--record', '1001'],
      {
        fetch: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          throw new Error('network must not be called');
        }) as typeof fetch,
      },
    );
    expect(requests).toEqual([]);
    expect(result.openHandles).toBe(0);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      version: number;
      complete: boolean;
      counts: { admitted: number };
      record: { found: boolean; kind: string };
      importInvocation: string[];
    };
    expect(document.version).toBe(1);
    expect(document.complete).toBe(true);
    expect(document.counts.admitted).toBeGreaterThan(0);
    expect(document.record.found).toBe(true);
    expect(document.importInvocation.join('\n')).toContain('--account-key <path>');
    expect(result.stdout).not.toContain('https://lain.bgm.tv');

    const paged = await runPreviewCli(['--plan-dir', output, '--page', 'new', '--limit', '1', '--json']);
    expect(paged.code).toBe(0);
    const page = JSON.parse(paged.stdout) as { page: { rows: unknown[]; nextCursor?: string } };
    expect(page.page.rows).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
