import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { campaignFixture, root } from '../../../infra/jena/tests/erasure-campaign-support.ts';

const fixtures: ReturnType<typeof campaignFixture>[] = [];
const children: ChildProcess[] = [];
const fixture = () => {
  const f = campaignFixture();
  fixtures.push(f);
  return f;
};
const prepared = () => {
  const f = fixture();
  expect(f.build().status).toBe(0);
  f.verify();
  return f;
};
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  for (const f of fixtures.splice(0)) f.cleanup();
});

test('interrupted two-rename campaign promotion stays fenced and explicitly restores exact source', () => {
  const f = prepared();
  f.executable(
    'mv',
    'if [ "$1" = "$TEST_BASE/databases/candidate/databases/rezics" ]; then exit 1; fi\nexec /bin/mv "$@"',
  );
  expect(f.act('activate').status).toBe(1);
  expect(f.exists(f.marker)).toBe(true);
  expect(f.exists(f.state)).toBe(false);
  expect(f.exists(f.retired)).toBe(true);
  expect(f.act('destroy').status).toBe(75);
  expect(f.act('activate').status).toBe(75);
  expect(f.act('rollback').status).toBe(0);
  expect(f.exists(f.marker)).toBe(false);
  expect(readFileSync(join(f.state, 'tdb2/Data-0001/quads'), 'utf8')).toContain(
    'private erased payload',
  );
  expect(readFileSync(join(f.record, 'phase'), 'utf8')).toBe('rolled-back\n');
  expect(f.act('rollback').status).toBe(0);
});

test('rollback itself can resume between renames, but refuses foreign fences or resumed candidate', () => {
  const f = prepared();
  expect(f.act('activate').status).toBe(0);
  writeFileSync(f.marker, 'foreign maintenance\n');
  expect(f.act('rollback').status).toBe(75);
  rmSync(f.marker);
  rmSync(join(f.state, 'clean-stop'));
  // Keep the previous inode allocated, so recreating the marker cannot reuse it.
  writeFileSync(join(f.state, 'other-file'), 'occupy inode');
  writeFileSync(join(f.state, 'clean-stop'), 'later stop');
  expect(f.act('rollback').status).toBe(75);

  const g = prepared();
  expect(g.act('activate').status).toBe(0);
  g.executable(
    'mv',
    'if [ "$1" = "$TEST_BASE/databases/rezics-retired-maintenance" ]; then exit 1; fi\nexec /bin/mv "$@"',
  );
  expect(g.act('rollback').status).toBe(1);
  expect(g.exists(g.state)).toBe(false);
  expect(g.exists(g.marker)).toBe(true);
  rmSync(join(g.bin, 'mv'));
  expect(g.act('rollback').status).toBe(0);
  expect(g.exists(g.state)).toBe(true);
  expect(g.exists(g.marker)).toBe(false);
});

test('partial retained source unlink resumes only with durable exact authorization', () => {
  const f = prepared();
  expect(f.act('activate').status).toBe(0);
  f.executable(
    'rm',
    'if [ "$1" = -rf ]; then /bin/rm "$2/lucene/segments_1"; exit 1; fi\nexec /bin/rm "$@"',
  );
  expect(f.act('destroy').status).toBe(1);
  expect(readFileSync(join(f.record, 'phase'), 'utf8')).toBe('destroying\n');
  expect(f.exists(join(f.retired, 'lucene/segments_1'))).toBe(false);
  writeFileSync(join(f.record, 'destruction-authorized'), 'corrupt');
  expect(f.act('destroy').status).toBe(75);
  expect(f.exists(f.retired)).toBe(true);
});

test('authorized interrupted destruction retries while preserving active candidate', () => {
  const f = prepared();
  expect(f.act('activate').status).toBe(0);
  f.executable(
    'rm',
    'if [ "$1" = -rf ]; then /bin/rm "$2/lucene/segments_1"; exit 1; fi\nexec /bin/rm "$@"',
  );
  expect(f.act('destroy').status).toBe(1);
  rmSync(join(f.bin, 'rm'));
  expect(f.act('destroy').status).toBe(0);
  expect(f.exists(f.retired)).toBe(false);
  expect(readFileSync(join(f.state, 'tdb2/quads'), 'utf8')).toBe('retained unrelated bytes');
});

test('campaign promotion and inherited commands retain both owner locks throughout interruption', async () => {
  const f = prepared();
  f.executable('mv', 'touch "$TEST_BASE/mv-started"; sleep 30; exec /bin/mv "$@"');
  const child = spawn(
    'sh',
    [
      join(root, 'infra/jena/purge-activate.sh'),
      'activate',
      f.candidateBase,
      '--campaign',
      f.campaign,
      'maintenance',
    ],
    { env: f.env, detached: true, stdio: 'ignore' },
  );
  children.push(child);
  for (let i = 0; i < 200 && !f.exists(join(f.base, 'mv-started')); i++) await Bun.sleep(10);
  expect(f.exists(join(f.base, 'mv-started'))).toBe(true);
  expect(f.act('rollback').status).toBe(75);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  process.kill(child.pid!, 'SIGKILL');
  await exited;
  expect(f.act('rollback').status).toBe(75);
  process.kill(-child.pid!, 'SIGKILL');
  rmSync(join(f.bin, 'mv'));
  let rollback = f.act('rollback');
  for (let i = 0; i < 100 && rollback.status !== 0; i++) {
    await Bun.sleep(10);
    rollback = f.act('rollback');
  }
  expect(rollback.status).toBe(0);
});

test('completed campaign cutover can roll back before resume and denies corrupt candidate proof', () => {
  const f = prepared();
  expect(f.act('activate').status).toBe(0);
  writeFileSync(join(f.state, 'erasure-purge.verified'), 'corrupt');
  expect(f.act('rollback').status).toBe(75);
  // The original source may already be restored, but startup must stay fenced
  // until the complete recorded candidate proof is recovered.
  expect(f.exists(f.marker)).toBe(true);
  writeFileSync(join(f.candidate, 'erasure-purge.verified'), readFileSync(join(f.record, 'ready')));
  expect(f.act('rollback').status).toBe(0);
  expect(f.exists(f.marker)).toBe(false);
});
