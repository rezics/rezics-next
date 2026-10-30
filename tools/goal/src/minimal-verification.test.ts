import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerCheckProtocol } from './launch.ts';

const brief = {
  acceptance: { command: ['bun', 'run', '--cwd', 'services/kernel', 'check', 'test/x.test.ts'] },
  markdown: '',
} as unknown as Parameters<typeof workerCheckProtocol>[1];

test('minimal verification mode replaces acceptance checks with a local type check', () => {
  const state = mkdtempSync(join(tmpdir(), 'goal-minimal-'));
  try {
    writeFileSync(join(state, 'verification-mode'), 'minimal\n');
    const protocol = workerCheckProtocol(state, brief, state);
    expect(protocol).toContain('Verification is minimal');
    expect(protocol).toContain('typecheck');
    expect(protocol).toContain('compiler database');
    expect(protocol).not.toContain('Run the acceptance command once');
    expect(protocol).not.toContain('--wait <id>`, poll');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('without the mode file the normal acceptance protocol is unchanged', () => {
  const state = mkdtempSync(join(tmpdir(), 'goal-minimal-'));
  try {
    expect(workerCheckProtocol(state, brief, state)).toContain('run your acceptance command once');
    writeFileSync(join(state, 'verification-mode'), 'full\n');
    expect(workerCheckProtocol(state, brief, state)).not.toContain('Verification is minimal');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
