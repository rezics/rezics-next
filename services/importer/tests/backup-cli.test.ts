import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { runImportCli } from '../src/cli.ts';
import { parseBackupArgs } from '../src/backup-cli.ts';
import { ImportSession } from '../src/import-session.ts';
import type { SourceProjection } from '../src/run-store.ts';

function directory() {
  return mkdtempSync(join(tmpdir(), 'importer-backup-cli-'));
}

function staged(key: string) {
  return {
    row: {
      source: 'wikidata',
      recordKey: key,
      recordRevision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    } satisfies SourceProjection,
  };
}

function command(recordKey: string): BatchCommand {
  return {
    op: 'create',
    key: `cmd-${recordKey}`,
    source: {
      source: 'wikidata',
      external_id: recordKey,
      record_revision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'facts',
    },
    subject: { type: 'item', labels: { en: 'Private request body sentinel' } },
  };
}

function seed(path: string) {
  const session = new ImportSession(path);
  const run = session.store.begin('wikidata');
  if (run === 'busy') throw new Error('run');
  session.store.stage(run, staged('Q1'));
  expect(session.store.seal(run, { complete: true }).status).toBe('ready');
  session.store.prepare(run, 'Q1', { commands: [command('Q1')] });
  session.close();
}

test('snapshot help is local and rejects import-only options', async () => {
  expect(parseBackupArgs(['backup', '--help'])).toBe('help');
  expect(() =>
    parseBackupArgs(['backup', '--state', 'state.sqlite', '--output', 'snap', '--account-key', 'account.key']),
  ).toThrow('import-only');
  const help = await runImportCli(['backup', '--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('Stopped-state snapshots are local');
  expect(help.openHandles).toBe(0);
});

test('CLI backup, validate and restore keep pending bytes and refuse unsafe paths', async () => {
  const dir = directory();
  const requests: string[] = [];
  try {
    const state = join(dir, 'state.sqlite');
    seed(state);
    const snapshot = join(dir, 'snapshot');
    const fetchBoundary = (async (input: Request | string | URL) => {
      requests.push(String(input instanceof Request ? input.url : input));
      throw new Error('snapshot commands must not use the network');
    }) as unknown as typeof fetch;
    const backup = await runImportCli(['backup', '--state', state, '--output', snapshot, '--json'], {
      fetch: fetchBoundary,
    });
    expect(backup.code).toBe(0);
    expect(JSON.parse(backup.stdout).status).toBe('ready');
    expect(JSON.parse(backup.stdout).runs[0].source).toBe('wikidata');
    expect(backup.stdout).not.toContain('Private request body sentinel');
    const validated = await runImportCli(['validate-snapshot', '--snapshot', snapshot, '--json'], {
      fetch: fetchBoundary,
    });
    expect(validated.code).toBe(0);
    expect(JSON.parse(validated.stdout).integrityPages).toBeGreaterThan(0);
    const restored = join(dir, 'restored.sqlite');
    const restore = await runImportCli(['restore', '--snapshot', snapshot, '--state', restored], {
      fetch: fetchBoundary,
    });
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain('cannot undo native writes');
    expect(restore.stdout).toContain(restored);
    const session = new ImportSession(restored);
    const active = session.store.activeRun('wikidata');
    expect(session.store.pagePending(active!, { limit: 1 })[0]?.keys).toEqual(['cmd-Q1']);
    session.close();
    const inspect = await runImportCli(['inspect', '--state', restored, '--source', 'wikidata', '--json']);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation.status).toBe('ready');
    const existing = await runImportCli(['backup', '--state', state, '--output', snapshot, '--json']);
    expect(existing.code).toBe(2);
    expect(JSON.parse(existing.stdout).error).toContain('already exists');
    const link = join(dir, 'linked.sqlite');
    symlinkSync(state, link);
    const refused = await runImportCli(['backup', '--state', link, '--output', join(dir, 'from-link'), '--json']);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout).error).toContain('symbolic link');
    const fifo = join(dir, 'state.pipe');
    expect(await Bun.spawn(['mkfifo', fifo]).exited).toBe(0);
    const fifoResult = await runImportCli(['backup', '--state', fifo, '--output', join(dir, 'from-fifo'), '--json']);
    expect(fifoResult.code).toBe(2);
    expect(existsSync(join(dir, 'from-fifo'))).toBe(false);
    writeFileSync(join(dir, 'parent-file'), 'nope');
    const failed = await runImportCli(
      ['restore', '--snapshot', snapshot, '--state', join(dir, 'parent-file', 'child.sqlite'), '--json'],
      { fetch: fetchBoundary },
    );
    expect(failed.code).toBeGreaterThan(0);
    expect(requests).toEqual([]);
    expect(backup.openHandles).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore refuses an existing state file and leaves the original intact', async () => {
  const dir = directory();
  try {
    const state = join(dir, 'state.sqlite');
    seed(state);
    const snapshot = join(dir, 'snapshot');
    expect((await runImportCli(['backup', '--state', state, '--output', snapshot])).code).toBe(0);
    const existing = await runImportCli(['restore', '--snapshot', snapshot, '--state', state, '--json']);
    expect(existing.code).toBe(2);
    expect(JSON.parse(existing.stdout).error).toContain('already exists');
    expect(new Database(state, { readonly: true }).query('SELECT COUNT(*) AS n FROM run_envelopes').get()).toEqual({
      n: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
