import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { campaignFixture, revision, rows } from './erasure-campaign-support.ts';

const fixtures: ReturnType<typeof campaignFixture>[] = [];
const fixture = () => {
  const f = campaignFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

test('bounded campaign copies/indexes/compacts once and records exact immutable source evidence', () => {
  const f = fixture();
  writeFileSync(
    f.campaign,
    Array.from({ length: 64 }, (_, i) => `${revision(i + 1)}\t${i + 1}\n`).join(''),
  );
  const built = f.build();
  expect(built.status).toBe(0);
  expect(readFileSync(join(f.candidate, 'erasure-campaign.tsv'), 'utf8')).toBe(
    readFileSync(f.campaign, 'utf8'),
  );
  const calls = readFileSync(join(f.base, 'java-calls'), 'utf8');
  expect(calls.match(/com.rezics.jena.ErasurePurge/g)).toHaveLength(1);
  expect(calls.match(/com.rezics.jena.ErasureTextIndexer/g)).toHaveLength(1);
  expect(readFileSync(join(f.base, 'compact-calls'), 'utf8')).toBe('compact\n');
  expect(readFileSync(join(f.candidate, 'erasure-purge.ready'), 'utf8')).toContain('targets=64\n');
  expect(readFileSync(join(f.state, 'tdb2/Data-0001/quads'), 'utf8')).toContain(
    'model/command/object custody',
  );
  expect(f.build().status).toBe(75);
});

test('all malformed, mixed, duplicate, oversized and non-LF inputs deny before Java or destination', () => {
  for (const input of [
    '',
    rows.trimEnd(),
    rows.replace('\n', '\r\n'),
    rows.replace('\t12', '\t0'),
    rows.replace('\t12', '\t01'),
    rows.replace('\t12', '\t10000000000000000000'),
    rows.replace('content:revision:', 'content:projection:'),
    rows.replace('00000000-', 'FFFFFFFF-'),
    rows + `${revision(1)}\t12\n`,
    rows + `${revision(1)}\t13\n`,
    rows + '\n',
    rows + '\0',
    Array.from({ length: 65 }, (_, i) => `${revision(i + 1)}\t1\n`).join(''),
  ]) {
    const f = fixture();
    writeFileSync(f.campaign, input);
    expect(f.build().status).toBe(64);
    expect(f.exists(f.candidateBase)).toBe(false);
    expect(f.exists(join(f.base, 'java-calls'))).toBe(false);
  }
});

test('single target is a campaign adapter and cannot activate legacy two-line evidence', () => {
  const f = fixture();
  expect(f.run('purge-tdb2', [f.candidateBase, revision(1), '12']).status).toBe(0);
  expect(readFileSync(join(f.candidate, 'erasure-campaign.tsv'), 'utf8')).toBe(
    `${revision(1)}\t12\n`,
  );
  f.verify();
  writeFileSync(join(f.candidate, 'erasure-purge.ready'), `${revision(1)}\n12\n`);
  writeFileSync(join(f.candidate, 'erasure-purge.verified'), `${revision(1)}\n12\n`);
  expect(
    f.run('purge-activate', ['activate', f.candidateBase, revision(1), '12', 'maintenance']).status,
  ).toBe(75);
  expect(f.exists(f.retired)).toBe(false);
});

test('activation binds snapshot, full retained payload bytes and external verification', () => {
  for (const failure of ['missing', 'snapshot', 'verified', 'retained', 'linked']) {
    const f = fixture();
    expect(f.build().status).toBe(0);
    f.verify();
    if (failure === 'missing') rmSync(join(f.candidate, 'erasure-purge.ready'));
    if (failure === 'snapshot')
      writeFileSync(join(f.candidate, 'erasure-campaign.tsv'), rows.replace('12', '13'));
    if (failure === 'verified')
      writeFileSync(join(f.candidate, 'erasure-purge.verified'), 'corrupt');
    if (failure === 'retained')
      writeFileSync(join(f.state, 'tdb2/Data-0001/quads'), 'changed old source');
    if (failure === 'linked')
      symlinkSync(join(f.state, 'lucene/segments_1'), join(f.state, 'linked'));
    expect(f.act('activate').status).toBe(75);
    expect(f.exists(f.retired)).toBe(false);
    expect(f.exists(f.marker)).toBe(false);
  }
});

test('exact retirement denies a different campaign/source and emits evidence binding every target', () => {
  const f = fixture();
  expect(f.build().status).toBe(0);
  f.verify();
  expect(f.act('activate').status).toBe(0);
  writeFileSync(f.campaign, `${revision(1)}\t12\n`);
  expect(f.act('destroy').status).toBe(75);
  writeFileSync(f.campaign, rows);
  writeFileSync(join(f.retired, 'lucene/segments_1'), 'changed source');
  expect(f.act('destroy').status).toBe(75);
  writeFileSync(join(f.retired, 'lucene/segments_1'), 'old text');
  const destroyed = f.act('destroy');
  expect(destroyed.status).toBe(0);
  expect(destroyed.stdout).toMatch(/evidence-sha256=[a-f0-9]{64}/);
  expect(destroyed.stdout).toContain('snapshots, backups and media remain unverified');
  expect(f.exists(f.retired)).toBe(false);
  expect(readFileSync(join(f.state, 'erasure-purge.retired-maintenance'), 'utf8')).toContain(
    'cutover-sha256=',
  );
  expect(readFileSync(join(f.record, 'campaign.tsv'), 'utf8')).toBe(rows);
  expect(f.act('destroy').status).toBe(0);
  expect(f.act('rollback').status).toBe(75);
});
