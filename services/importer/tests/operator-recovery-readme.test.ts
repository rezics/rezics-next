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
