import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readme = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');

function section(title: string): string {
  const start = readme.indexOf(`## ${title}\n`);
  if (start < 0) throw new Error(`missing section ${title}`);
  const rest = readme.slice(start + 3);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

test('checkpointed staging documents delivered producers without the superseded refusal', () => {
  const text = section('Resume a checkpointed local staging capture');
  expect(text).toContain('uncompressed Bangumi');
  expect(text).toContain('gzip');
  expect(text).toContain('Wikidata zstd');
  expect(text).toContain('dump-set manifest');
  expect(text).toContain('source-exact API destination');
  expect(text).toContain('SHA-256');
  expect(text).toContain('committed prefix');
  expect(text).toContain('256 GiB');
  expect(text).toContain('cannot compete with sealed recovery');
  expect(text).toContain('retire-staging');
  expect(text).toContain('one SQLite transaction');
  expect(text).not.toMatch(/gzip, stdin and multi-file manifests are refused/);
});

test('sealed resume does not host the staging checkpoint transaction decision', () => {
  const text = section('Resume a sealed generation without its dump');
  expect(text).not.toContain('checkpointed staging commits each accepted record');
  expect(text).toContain('does not open stdin');
});

test('statistic custody sits with VNDB observations; classification keeps its own seam', () => {
  const observations = section('Resolve VNDB source-observation conflicts');
  const classification = section('Resolve source-classification conflicts');
  expect(observations).toContain('run_aggregate_heads');
  expect(observations).toContain('/v1/subjects/{id}/source-statistics');
  expect(classification).not.toContain('run_aggregate_heads');
  expect(classification).not.toContain('/v1/subjects/{id}/source-statistics');
  expect(classification).toContain('run_classification_heads');
  expect(classification).toContain('AIP-136 HTTP seam');
  expect(classification).toContain('source-classifications:read');
});

test('complete-generation retirement and unpublished staging retirement stay distinct', () => {
  expect(readme).toContain('## Retire superseded complete generations');
  expect(readme).toContain('## Retire an unpublished staging capture');
  const staging = section('Retire an unpublished staging capture');
  expect(staging).toContain('--output');
  expect(staging).toContain('--plan');
  expect(staging).toContain('--apply');
  expect(staging).toContain('retire-staging');
});

test('Cost operation bounds list each identity once with current CLI and retirement rows', () => {
  const cost = section('Cost');
  const lines = cost.split('\n');
  const headers = lines.flatMap((line, index) => (line.startsWith('| Operation') ? [index] : []));
  expect(headers).toHaveLength(1);
  const rows: string[][] = [];
  for (let index = headers[0]! + 2; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }
  const ops = rows.map((row) => row[0]!);
  expect(ops).toHaveLength(33);
  expect(new Set(ops).size).toBe(33);
  expect(ops).toContain('Streaming zstd dump transform (`zstd-input.ts`)');
  expect(ops).toContain('Binding inspection overview, page and exact request (`binding-inspection-store.ts`)');
  expect(ops.indexOf('Retain conversion diagnostics (`run-store.ts`, `importer.ts`)')).toBe(
    ops.indexOf('Retire superseded complete generations (`retention.ts`, `retention-cli.ts`)') - 1,
  );
  expect(ops.indexOf('Retire superseded complete generations (`retention.ts`, `retention-cli.ts`)') + 1).toBe(
    ops.indexOf('Retire unpublished staging (`staging-retirement.ts`, `staging-retirement-cli.ts`)'),
  );
  expect(rows[0]![0]).toBe('CLI entry and bounded input (`cli.ts`)');
  expect(rows[0]![1]).toContain('zstd is rejected for Bangumi and Open Library');
  expect(rows[0]![1]).toContain('decompresses VNDB/Wikidata zstd dumps');
  expect(rows[0]![2]).toContain('gzip/zstd+decoder');
});
