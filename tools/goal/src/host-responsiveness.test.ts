import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLogTail } from './records.ts';
import { managerHostRestartAllowed } from './integration-cli.ts';

const MAX_TAIL = 256 * 1024;

test('watchdog and settle log scans are bounded to a line-aligned 256 KiB suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-tail-'));
  try {
    const path = join(root, 'attempt.jsonl');
    const prefix = `${JSON.stringify({ item: { type: 'command_execution', id: 'old', command: 'old-command' } })}\n`;
    const filler = `${JSON.stringify({ type: 'progress', text: 'x'.repeat(4096) })}\n`.repeat(80);
    const final = `${JSON.stringify({ item: { type: 'command_execution', id: 'last', command: 'bun test latest' } })}\n`;
    writeFileSync(path, prefix + filler + final);
    const tail = readLogTail(path);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX_TAIL);
    expect(tail.startsWith('{')).toBe(true);
    expect(tail).toContain('bun test latest');
    expect(tail).not.toContain('old-command');
    expect(statSync(path).size).toBeGreaterThan(MAX_TAIL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale manager host records at most one restart in each ten-minute interval', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-restart-'));
  try {
    expect(managerHostRestartAllowed(root, 1_000_000)).toBe(true);
    expect(managerHostRestartAllowed(root, 1_599_999)).toBe(false);
    expect(managerHostRestartAllowed(root, 1_600_000)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('log-tail reads remain usable when the final event follows a multi-megabyte prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-host-large-log-'));
  try {
    const path = join(root, 'attempt.jsonl');
    writeFileSync(path, `${'x'.repeat(3 * 1024 * 1024)}\n${JSON.stringify({ result: 'failure: final line' })}\n`);
    expect(readLogTail(path)).toContain('failure: final line');
    expect(Buffer.byteLength(readLogTail(path))).toBeLessThanOrEqual(MAX_TAIL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
