import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPACTION_IMAGE_GUARD, compactTdb2, parseCompactionOptions } from '../compact-tdb2.ts';

const args = [
  'compact',
  '--window',
  'maintenance',
  '--retain-until',
  '2035-01-01T00:00:00Z',
  '--writers-stopped',
];
const now = Date.parse('2034-01-01T00:00:00Z');

test('operator entrypoint passes a bounded named recovery window to the offline pinned service', () => {
  const options = parseCompactionOptions(
    [...args, '--profile', 'qa', '--run-id', 'fixture-compaction', '--persistent'],
    now,
  );
  const calls: string[][] = [];
  expect(
    compactTdb2(options, (call) => {
      calls.push(call);
      return 'retained evidence';
    }),
  ).toBe('retained evidence');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('--no-deps');
  expect(calls[0]!.slice(-4)).toEqual(['compact', 'maintenance', '2051222400', '1073741824']);
  expect(calls[0]).not.toContain('stop');
  expect(calls[0]).not.toContain('up');
});

test('maintenance requires stopped-writer acknowledgement and persistent QA storage', () => {
  expect(() =>
    parseCompactionOptions(
      args.filter((arg) => arg !== '--writers-stopped'),
      now,
    ),
  ).toThrow('writers');
  expect(() =>
    parseCompactionOptions([...args, '--profile', 'qa', '--run-id', 'fixture-compaction'], now),
  ).toThrow('persistent');
  expect(() =>
    parseCompactionOptions(
      [
        ...args,
        '--profile',
        'qa',
        '--run-id',
        'fixture-compaction',
        '--persistent',
        '--raw-update',
      ],
      now,
    ),
  ).toThrow('raw update');
});

test('invalid, duplicate and expired options cannot reach maintenance', () => {
  for (const bad of [
    ['--window', '../escape'],
    ['--window', 'a;touch'],
    ['--retain-until', '2030-01-01T00:00:00Z'],
    ['--retain-until', '2035-02-30T00:00:00Z'],
    ['--reserve-bytes', '-1'],
    ['--reserve-bytes', '1000000000000000'],
  ]) {
    expect(() => parseCompactionOptions([...args, ...bad], now)).toThrow();
  }
  expect(() =>
    parseCompactionOptions(
      args.map((arg) => (arg === '2035-01-01T00:00:00Z' ? '2035-02-30T00:00:00Z' : arg)),
      now,
    ),
  ).toThrow();
});

test('explicit retirement and rollback use the exact window and propagate refusal', () => {
  expect(() =>
    parseCompactionOptions(['retire', '--window', 'maintenance', '--writers-stopped'], now),
  ).toThrow('verified');
  const retire = parseCompactionOptions(
    ['retire', '--window', 'maintenance', '--verified', '--writers-stopped'],
    now,
  );
  compactTdb2(retire, (call) => {
    expect(call.slice(-3)).toEqual(['retire', 'maintenance', '--verified']);
    return 'retired';
  });
  const rollback = parseCompactionOptions(
    ['rollback', '--window', 'maintenance', '--writers-stopped'],
    now,
  );
  expect(() =>
    compactTdb2(rollback, () => {
      throw new Error('live owner');
    }),
  ).toThrow('live owner');
});

test('stale owner image refuses before maintenance; matching image dispatches unchanged arguments', () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const base = mkdtempSync(join(root, '.temp/compaction-image-'));
  try {
    writeFileSync(join(base, 'sha256sum'), '#!/bin/sh\nprintf "%s owner\\n" "$IMAGE_DIGEST"\n', {
      mode: 0o755,
    });
    const maintenance = join(base, 'maintenance.sh');
    writeFileSync(maintenance, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const run = (digest: string) =>
      spawnSync(
        'sh',
        [
          '-ec',
          COMPACTION_IMAGE_GUARD,
          'tdb2-compact',
          'expected',
          maintenance,
          'rollback',
          'named-window',
        ],
        {
          env: { ...process.env, PATH: `${base}:${process.env.PATH}`, IMAGE_DIGEST: digest },
          encoding: 'utf8',
        },
      );
    const stale = run('old-image');
    expect(stale.status).toBe(75);
    expect(stale.stderr).toContain('Rebuild the pinned Fuseki image');
    expect(stale.stdout).toBe('');
    const matching = run('expected');
    expect(matching.status).toBe(0);
    expect(matching.stdout).toBe('rollback\nnamed-window\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
