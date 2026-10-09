import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { devPorts } from '../../../scripts/dev/config.ts';
import { runWorkerPreview } from '../../../scripts/dev/preview.ts';
import { recordedStackArgs, rememberDevStack, startedDevStacks, stopDevSession }
  from '../../../scripts/dev/stack-session.ts';
import { freshPorts } from '../../../scripts/fixture/stack.ts';
import { replayCommand, type CommandEnvelope } from '../../../scripts/lib/command-journal.ts';
import { allocatePortSet } from '../../../scripts/lib/ports.ts';
import { digest, openJournal } from '../../../scripts/ops/bootstrap/journal.ts';
import type { BootstrapApi } from '../../../scripts/ops/bootstrap/api.ts';
import { cleanupQaStacks, rememberQaStack } from '../../../scripts/qa/stack-ownership.ts';
import { allocateWebPort } from '../../../scripts/qa/e2e.ts';

const root = resolve(import.meta.dir, '../../..');

function portFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolveFree) => {
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveFree(true));
    });
  });
}

test('a port set gives each name a distinct free loopback port', async () => {
  const ports = await allocatePortSet(['MAIN_PORT', 'ACCOUNT_PORT', 'ACCOUNTS_PORT']);
  const values = Object.values(ports);
  expect(new Set(values).size).toBe(values.length);
  for (const port of values) expect(await portFree(port)).toBe(true);
  const fresh = await freshPorts();
  expect(Object.keys(fresh).sort()).toEqual(Object.keys(devPorts()).sort());
  const numbers = Object.values(fresh).map(Number);
  expect(new Set(numbers).size).toBe(numbers.length);
  expect(numbers.every((port) => Number.isInteger(port) && port > 0)).toBe(true);
});

test('a failed stack stop leaves the registry record retryable', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const checkout = mkdtempSync(join(root, '.temp', 'dev-tooling-session-'));
  const directory = mkdtempSync(join(root, '.temp', 'dev-tooling-qa-'));
  try {
    const options = {
      profile: 'qa' as const,
      runId: 'wt-stop',
      persistent: true,
      rawUpdate: true,
      accountsApp: true,
    };
    rememberDevStack(checkout, options);
    expect(startedDevStacks(checkout)).toEqual([options]);
    expect(() => stopDevSession(checkout, () => {}, () => {
      throw new Error('Docker unavailable');
    })).toThrow('Docker unavailable');
    expect(startedDevStacks(checkout)).toEqual([options]);
    expect(recordedStackArgs(options)).toEqual([
      '--profile', 'qa', '--run-id', 'wt-stop', '--persistent', '--raw-update',
    ]);
    rememberQaStack(options, directory);
    expect(JSON.parse(readFileSync(join(directory, 'rezics-qa-wt-stop.json'), 'utf8'))).toEqual(
      recordedStackArgs(options),
    );
    const failed = await cleanupQaStacks(directory, async () => {
      throw new Error('Docker unavailable');
    });
    expect(failed).toEqual(['rezics-qa-wt-stop.json: Docker unavailable']);
    expect(readdirSync(directory)).toEqual(['rezics-qa-wt-stop.json']);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('web preview binds only after the port holder releases', async () => {
  const reserved = await allocateWebPort();
  const directory = mkdtempSync(join(root, '.temp', 'dev-tooling-preview-'));
  const log = join(directory, 'order');
  const buildScript = join(directory, 'build.ts');
  const serveScript = join(directory, 'serve.ts');
  writeFileSync(buildScript, `import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
const port = Number(process.env.PREVIEW_PORT);
const log = process.env.PREVIEW_LOG;
const server = createServer();
server.once('error', () => { appendFileSync(log, 'build-held\\n'); process.exit(0); });
server.listen(port, '127.0.0.1', () => {
  server.close(() => { appendFileSync(log, 'build-free\\n'); process.exit(1); });
});
`);
  writeFileSync(serveScript, `import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
const port = Number(process.env.PREVIEW_PORT);
const log = process.env.PREVIEW_LOG;
const server = createServer();
server.once('error', () => { appendFileSync(log, 'serve-blocked\\n'); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  appendFileSync(log, 'serve-bound\\n');
  server.close(() => process.exit(0));
});
`);
  try {
    await runWorkerPreview({
      root,
      directory,
      port: String(reserved.port),
      buildFailure: 'Web Worker build failed',
      env: { ...process.env, PREVIEW_PORT: String(reserved.port), PREVIEW_LOG: log },
      buildCommand: [process.execPath, buildScript],
      serveCommand: [process.execPath, serveScript],
    }, reserved.pid);
    expect(readFileSync(log, 'utf8')).toBe('build-held\nserve-bound\n');
  } finally {
    process.exitCode = undefined;
    reserved.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a recorded journal replays the same request bytes, idempotency key and intent digest', async () => {
  const folder = mkdtempSync(join(root, '.temp', 'dev-tooling-journal-'));
  const file = join(folder, 'journal.json');
  const body = { expectedHead: 'captured-head', candidateReceipt: 'captured-search' };
  const plan = digest('plan');
  const intent = digest('same-intent');
  writeFileSync(file, `${JSON.stringify({
    profile: 'launch-bootstrap-journal-v1',
    planDigest: plan,
    actor: 'original-actor',
    entries: { stable: { method: 'POST', path: '/v1/works', body, intent } },
  }, null, 2)}\n`);
  const writes: { body: unknown; key: string }[] = [];
  const api: BootstrapApi = {
    read: async <T>() => ({}) as T,
    write: async <T>(_method, _path, submitted, key) => {
      writes.push({ body: submitted, key });
      return { receipt: 'owner-confirmed' } as T;
    },
  };
  try {
    const journal = await openJournal(file, plan, 'original-actor');
    expect(await journal.command(api, 'stable', 'POST', '/v1/works', { expectedHead: 'replaced' }, 'same-intent'))
      .toEqual({ receipt: 'owner-confirmed' });
    expect(writes).toEqual([{ body, key: 'stable' }]);
    expect(digest(writes[0]!.body)).toBe(digest(body));
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.stable.intent).toBe(intent);
    await journal.command(api, 'stable', 'POST', '/v1/works', { expectedHead: 'again' }, 'same-intent');
    expect(writes).toHaveLength(1);
    await expect(journal.command(api, 'stable', 'POST', '/v1/works', body, 'changed-intent'))
      .rejects.toThrow('changed its intent');
    expect(writes).toHaveLength(1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('per-entry replay keeps recorded request bytes and does not rewrite other commands', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'dev-tooling-entries-'));
  const body = { retention: 'retained', rawBytesBase64: Buffer.from('{"record":1}').toString('base64') };
  const entries: Record<string, CommandEnvelope> = {};
  const writeEntry = (label: string, entry: CommandEnvelope) => {
    entries[label] = entry;
    writeFileSync(join(directory, `${label}.json`), `${JSON.stringify({ label, entry })}\n`);
  };
  writeEntry('other', { method: 'POST', path: '/v1/works', body: { id: 1 } });
  const sibling = readFileSync(join(directory, 'other.json'));
  writeEntry('intake', { method: 'POST', path: '/v1/sources/intakes', body });
  const key = 'dataset:recorded';
  const sent: { body: unknown; key?: string }[] = [];
  const store = {
    read: () => entries.intake,
    write: (entry: CommandEnvelope) => writeEntry('intake', entry),
  };
  try {
    await expect(replayCommand(store, {
      method: 'POST',
      path: '/v1/sources/intakes',
      body,
      outcome: 'result',
      changed: 'Dataset request changed: intake',
    }, async (entry) => {
      sent.push({ body: entry.body, key });
      throw new Error('lost');
    })).rejects.toThrow('lost');
    expect(sent).toEqual([{ body, key }]);
    expect(digest(sent[0]!.body)).toBe(digest(body));
    expect(readFileSync(join(directory, 'other.json'))).toEqual(sibling);
    const replayed = await replayCommand(store, {
      method: 'POST',
      path: '/v1/sources/intakes',
      body: { retention: 'replaced' },
      outcome: 'result',
      changed: 'Dataset request changed: intake',
    }, async (entry) => {
      sent.push({ body: entry.body, key });
      return { observation: 'kept' };
    });
    expect(replayed).toEqual({ observation: 'kept' });
    expect(sent[1]).toEqual({ body, key });
    expect(readFileSync(join(directory, 'other.json'))).toEqual(sibling);
    expect(JSON.parse(readFileSync(join(directory, 'intake.json'), 'utf8')).entry.body).toEqual(body);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
