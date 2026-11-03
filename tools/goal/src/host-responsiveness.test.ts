import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLogTail } from './records.ts';
import { hostRequest } from './integration-cli.ts';
import { readControlPolicy } from './policy.ts';

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

test('host RPC uses local policy and explicit arguments retain precedence', async () => {
  const policy = readControlPolicy({ host: { requestTimeoutMs: 15, requestRetryMs: 1 } }).host;
  await expect(hostRequest('missing.sock', { command: 'decision' }, undefined, undefined, policy)).rejects.toThrow(
    'after 15ms',
  );
  await expect(hostRequest('missing.sock', { command: 'decision' }, 30, 0, policy)).rejects.toThrow('after 30ms');
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
