import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readme = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');

function section(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`missing section ${heading}`);
  const rest = readme.slice(start + heading.length + 1);
  const level = heading.indexOf(' ');
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

const recovery = section('## Command line, metadata and recovery');

function paragraph(text: string, marker: string): string {
  const match = text.split(/\n\s*\n/).find((part) => part.includes(marker));
  if (!match) throw new Error(`missing paragraph for ${marker}`);
  return match.replace(/\s+/g, ' ');
}

test('checkpointed staging documents exact input, destination and atomic seal', () => {
  const staging = paragraph(recovery, '`--checkpoint-staging`');
  expect(staging).toContain('`--resume-staging --generation <id>`');
  expect(staging).toContain('uncompressed Bangumi regular file');
  expect(staging).toContain('plain, gzip, or Wikidata zstd');
  expect(staging).toContain('Open Library dump-set manifest');
  expect(staging).toContain('source-exact API destination before credentials or capture mutation');
  expect(staging).toContain('original-byte SHA-256');
  expect(staging).toMatch(/rehashes the original bytes.*verify the committed prefix/);
  expect(staging).toMatch(/accepted record and its prefix cursor commit in one SQLite transaction/);
  expect(staging).toMatch(/Seal updates generation state and removes the checkpoint in the same transaction/);
  expect(recovery).toContain('256 GiB');
  expect(recovery).not.toMatch(/gzip, stdin and multi-file manifests are refused/);
});

test('sealed resume needs its journal and opens no input', () => {
  const resume = paragraph(recovery, '`rezics-import resume`');
  expect(resume).toContain('existing sealed generation from its journal');
  expect(resume).toContain('does not open stdin, the dump or the archive');
  expect(resume).not.toContain('`--resume-staging');
});

test('VNDB observations and source classifications retain distinct head and API custody', () => {
  const observations = paragraph(recovery, 'Use `observations`');
  const classification = paragraph(recovery, 'Use `classifications`');
  expect(observations).toContain('run_aggregate_heads');
  expect(observations).toContain('/v1/subjects/{id}/source-statistics');
  expect(observations).not.toContain('run_classification_heads');
  expect(observations).not.toContain('source-classifications');
  expect(classification).not.toContain('run_aggregate_heads');
  expect(classification).not.toContain('/v1/subjects/{id}/source-statistics');
  expect(classification).toContain('run_classification_heads');
  expect(classification).toContain('/v1/subjects/{id}/source-classifications:read');
  for (const method of ['$read', '$put', '$clear']) expect(classification).toContain(method);
  expect(classification).toContain('--resolve --reviewed-observation <digest>');
});

test('complete-generation retirement and unpublished staging retirement stay distinct', () => {
  const retirement = paragraph(recovery, '`rezics-import retire-staging`');
  expect(retirement).toContain('`rezics-import retention` pages generation history');
  expect(retirement).toContain('plans cleanup for explicitly selected superseded complete generations');
  expect(retirement).toContain('`rezics-import retire-staging` defaults to read-only review of one exact unpublished capture');
  expect(retirement).toContain('`--source` and `--generation`');
  expect(retirement).toContain('review plan with `--output`');
  expect(retirement).toContain('`--plan <path> --confirm <plan-id> --apply` to revalidate and apply that selection');
});

test('operation bounds pair distinct operations with their owned evidence', () => {
  const cost = section('### Operation bounds and growth evidence');
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
  expect(new Set(ops).size).toBe(ops.length);
  const cases = [
    ['CLI/preflight', /one owned stream/, 'cli-outcomes.test.ts'],
    ['gzip transform', /256 KiB windows/, 'compressed-dump-growth.test.ts'],
    ['zstd transform', /parent windows ≤256 KiB/, 'zstd-input.test.ts', 'cli-zstd.test.ts'],
    ['Conversion diagnostics', /≤4 statements per record/, 'conversion-diagnostics-growth.test.ts'],
    ['Retire complete generations', /pages ≤100, ≤100 explicitly selected generations/, 'retention-growth.test.ts'],
    ['Retire unpublished staging', /one exact generation.*pages ≤100/i, 'staging-retirement-growth.test.ts'],
    ['Diagnostic/binding inspection', /keyset P≤100/, 'binding-inspection-growth.test.ts'],
    ['Staging checkpoint resume', /hash complete local bytes.*indexed prefix\/checkpoint/i, 'staging-checkpoint.test.ts'],
  ] as const;
  for (const [operation, bound, ...evidence] of cases) {
    const row = rows.find(([name]) => name === operation);
    if (!row) throw new Error(`missing operation ${operation}`);
    expect(row[1]).toMatch(bound);
    for (const file of evidence) expect(row[2]).toContain(`\`tests/${file}\``);
  }
  expect(recovery).toMatch(/zstd for VNDB\/Wikidata/);
  expect(recovery).toMatch(/zstd for Bangumi\/Open Library before credentials or state/);
});
