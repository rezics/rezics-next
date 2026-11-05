import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImportCli } from '../src/cli.ts';
import { parseCompareArgs, runCompareCli } from '../src/compare-cli.ts';
import { DumpPreview } from '../src/dump-preview.ts';

const fixture = (path: string) => new URL(`../../../specs/fixtures/imports/${path}`, import.meta.url);

async function completedPlan(
  directory: string,
  name: string,
  dump: string,
  source: 'bangumi' | 'wikidata' = 'wikidata',
) {
  const output = join(directory, name);
  const preview = await DumpPreview.build({ source, dump, outputDir: output });
  await preview.close();
  return output;
}

function wikidataItems(
  count: number,
  title = (index: number) => `Item ${index}`,
  extra: (index: number) => Record<string, unknown> = () => ({}),
) {
  const items = Array.from({ length: count }, (_, index) => ({
    type: 'item',
    id: `Q${1000 + index}`,
    lastrevid: 10 + index,
    labels: { en: { language: 'en', value: title(index) } },
    descriptions: {},
    aliases: extra(index).aliases ?? {},
    claims: extra(index).claims ?? {},
    sitelinks: {},
  }));
  return `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`;
}

test('compare help is self-contained and rejects every import-only option', async () => {
  expect(parseCompareArgs(['--help'])).toBe('help');
  expect(() => parseCompareArgs(['--left', 'l', '--right', 'r', '--account-key', 'account.key'])).toThrow(
    'Unknown, import-only or repeated comparison flag',
  );
  expect(() => parseCompareArgs(['--left', 'l', '--right', 'r', '--limit', '20'])).toThrow('--limit requires --page');
  const help = await runCompareCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('local and offline');
  expect(help.stdout).toContain('never imports');
  expect(help.openHandles).toBe(0);
});

test('compare CLI inspects two completed plans and returns to ordinary import without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'compare-cli-'));
  try {
    const leftDump = join(directory, 'left.json');
    const rightDump = join(directory, 'right.json');
    await writeFile(
      leftDump,
      wikidataItems(3, (index) => (index === 0 ? 'Original' : `Item ${index}`)),
    );
    await writeFile(
      rightDump,
      wikidataItems(
        3,
        (index) => (index === 0 ? 'Corrected \u202ehostile' : `Item ${index}`),
        (index) => (index === 1 ? { aliases: { en: [{ language: 'en', value: 'Harbor alias' }] } } : {}),
      ),
    );
    const left = await completedPlan(directory, 'left-plan', leftDump);
    const right = await completedPlan(directory, 'right-plan', rightDump);
    const output = join(directory, 'comparison');
    const requests: string[] = [];
    const result = await runImportCli(
      [
        'compare',
        '--left',
        left,
        '--right',
        right,
        '--output-dir',
        output,
        '--json',
        '--page',
        'changed',
        '--record',
        'Q1000',
      ],
      {
        fetch: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          throw new Error('network must not be called');
        }) as unknown as typeof fetch,
      },
    );
    expect(requests).toEqual([]);
    expect(result.openHandles).toBe(0);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      version: number;
      complete: boolean;
      sourceKind: string;
      counts: { changed: number; onlyLeft: number; onlyRight: number };
      record: { found: boolean; kind: string; digestDiffers: boolean };
      importInvocation: string[];
      left: { dumpPath: string };
    };
    expect(document.version).toBe(1);
    expect(document.complete).toBe(true);
    expect(document.sourceKind).toBe('wikidata');
    expect(document.counts.changed).toBeGreaterThan(0);
    expect(document.record.found).toBe(true);
    expect(document.record.kind).toBe('changed');
    expect(document.importInvocation.join('\n')).toContain('--account-key <path>');
    expect(document.importInvocation.join('\n')).toContain('--source wikidata');
    expect(result.stdout).not.toContain('\u202e');
    expect(result.stdout).not.toContain('account.key');

    const reopened = await runCompareCli(['--comparison-dir', output, '--page', 'changed', '--limit', '1', '--json']);
    expect(reopened.code).toBe(0);
    const page = JSON.parse(reopened.stdout) as { page: { rows: unknown[]; nextCursor?: string }; complete: boolean };
    expect(page.complete).toBe(true);
    expect(page.page.rows).toHaveLength(1);

    const wrong = await runCompareCli([
      '--comparison-dir',
      output,
      '--page',
      'only-left',
      '--cursor',
      page.page.nextCursor ?? 'aaa',
      '--json',
    ]);
    expect(wrong.code).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compare CLI refuses incomplete, colliding, mismatched and malformed work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'compare-cli-reject-'));
  try {
    const dump = join(directory, 'ok.json');
    await writeFile(dump, wikidataItems(2));
    const left = await completedPlan(directory, 'ok-plan', dump);
    const brokenDump = join(directory, 'broken.json');
    await writeFile(brokenDump, '[\n{"type":"item","id":"Q1"\n');
    const incompleteDir = join(directory, 'incomplete');
    const incomplete = await DumpPreview.build({ source: 'wikidata', dump: brokenDump, outputDir: incompleteDir });
    expect(incomplete.plan.complete).toBe(false);
    await incomplete.close();

    const incompleteResult = await runCompareCli(['--left', incompleteDir, '--right', left, '--json']);
    expect(incompleteResult.code).toBe(2);
    expect(incompleteResult.stdout).toContain('incomplete');

    const bangumi = join(directory, 'bangumi.jsonl');
    await writeFile(bangumi, await readFile(fixture('dumps/bangumi-subject.jsonlines')));
    const bangumiPlan = await completedPlan(directory, 'bangumi-plan', bangumi, 'bangumi');
    const mismatch = await runCompareCli(['--left', left, '--right', bangumiPlan]);
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toContain('different configured sources');

    const output = join(directory, 'retained');
    const first = await runCompareCli(['--left', left, '--right', left, '--output-dir', output, '--json']);
    expect(first.code).toBe(0);
    const collision = await runCompareCli(['--left', left, '--right', left, '--output-dir', output]);
    expect(collision.code).toBe(2);
    expect(collision.stderr).toContain('already contains a database');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runCompareCli(['--left', left, '--right', left], { signal: controller.signal });
    expect(cancelled.code).toBe(130);
    expect(cancelled.openHandles).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
