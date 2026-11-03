import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const bangumi = {
  id: 910001,
  type: 2,
  name: 'The Binding Observatory',
  images: { large: 'https://lain.bgm.tv/cover.jpg' },
};
const uncertain = {
  id: 910002,
  type: 2,
  name: 'The Uncertain Observatory',
};

function feed(rows: object[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

type BindingRow = { state: string; subject: string | null; bootstrap_key: string };
type JournalRow = { key: string; bytes: string; acknowledgement: string | null };

/** Ordinary native imports, local binding inspection without network, then authorized resume of the original request. */
export async function runCliBindingInspectionJourney() {
  const previousTemporaryDirectory = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = '/dev/shm';
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryDirectory;
    }
  })();
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp('/dev/shm/cli-binding-inspection-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const dumpPath = join(directory, 'bangumi.jsonl');
    const identity = runtime.identity;
    const support = identitySupport(identity);
    await openApiObserver(runtime);
    await support.renewManagement();
    const kid = randomUUID();
    const keys = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(keys.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: support.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(keys.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const api = 'https://kernel.import.test';
    const argv = [
      '--source',
      'bangumi',
      '--dump',
      dumpPath,
      '--state',
      state,
      '--api',
      api,
      '--auth',
      auth,
      '--account-key',
      keyPath,
      '--account',
      identity.bulk.accountId,
      '--client',
      identity.client.clientId,
    ];
    const originalCreates = new Map<string, string>();
    let loseBootstrap = false;
    const replay: typeof fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === auth) return support.host.service.handler(request);
      expect(url.origin).toBe(api);
      const bytes = await request.clone().text();
      if (url.pathname === '/v1/subjects:batchWrite') {
        const body = JSON.parse(bytes) as BatchWriteRequest;
        for (const command of body.commands) {
          runtime.commands.set(command.key, { command, actor: identity.bulk.accountId });
          if (command.op === 'create') originalCreates.set(command.source.external_id, bytes);
        }
        const response = await runtime.replay(request);
        if (loseBootstrap && body.commands.some((command) => command.op === 'create')) {
          loseBootstrap = false;
          throw new TypeError('Lost bootstrap response');
        }
        return response;
      }
      return runtime.replay(request);
    }) as unknown as typeof fetch;

    await writeFile(dumpPath, feed([bangumi]), { mode: 0o600 });
    const acknowledged = await runImportCli(argv, { fetch: replay });
    expect(acknowledged.code).toBe(0);
    expect(acknowledged.openHandles).toBe(0);

    loseBootstrap = true;
    await writeFile(dumpPath, feed([bangumi, uncertain]), { mode: 0o600 });
    const interrupted = await runImportCli(argv, { fetch: replay });
    expect(interrupted.code).not.toBe(0);
    expect(interrupted.openHandles).toBe(0);

    const before = readBindings(state, 'bangumi', String(uncertain.id));
    expect(before.record?.state).toBe('pending');
    expect(before.journals.some((row) => row.acknowledgement === null)).toBe(true);

    let network = 0;
    const inspectBound = await runImportCli(
      ['inspect-bindings', '--state', state, '--source', 'bangumi', '--record', String(bangumi.id), '--json'],
      {
        fetch: (async () => {
          network++;
          throw new Error('binding inspection must not use the network');
        }) as unknown as typeof fetch,
      },
    );
    const inspectPending = await runImportCli(
      [
        'inspect-bindings',
        '--state',
        state,
        '--source',
        'bangumi',
        '--record',
        String(uncertain.id),
        '--page',
        'semantic',
        '--json',
      ],
      {
        fetch: (async () => {
          network++;
          throw new Error('binding inspection must not use the network');
        }) as unknown as typeof fetch,
      },
    );
    expect(network).toBe(0);
    expect(inspectBound.code).toBe(0);
    expect(inspectPending.code).toBe(0);
    const boundDocument = JSON.parse(inspectBound.stdout) as {
      binding: { state: string; subject: string };
      request: null;
    };
    const pendingDocument = JSON.parse(inspectPending.stdout) as {
      binding: { state: string; subject: null };
      page: { rows: { acknowledgement: string; body: { sha256: string } }[] };
    };
    expect(boundDocument.binding.state).toBe('bound');
    expect(boundDocument.binding.subject).toMatch(/^[0-9a-f-]{36}$/);
    expect(pendingDocument.binding.state).toBe('pending');
    expect(pendingDocument.page.rows.some((row) => row.acknowledgement === 'absent')).toBe(true);
    expect(inspectBound.stdout).not.toContain('lain.bgm.tv');
    expect(inspectPending.stdout).not.toContain('The Uncertain Observatory');

    const afterInspect = readBindings(state, 'bangumi', String(uncertain.id));
    expect(afterInspect).toEqual(before);

    const resumed = await runImportCli(argv, { fetch: replay });
    expect(resumed.code).toBe(0);
    const afterResume = readBindings(state, 'bangumi', String(uncertain.id));
    expect(afterResume.record?.state).toBe('bound');
    expect(afterResume.record?.subject).toMatch(/^[0-9a-f-]{36}$/);
    expect(afterResume.record?.subject).not.toBe(boundDocument.binding.subject);
    const original = originalCreates.get(String(uncertain.id));
    expect(original).toBeString();
    expect(afterResume.journals.some((row) => row.bytes === original && row.acknowledgement !== null)).toBe(true);
    return {
      inspectBound,
      inspectPending,
      resumed,
      acknowledgedSubject: boundDocument.binding.subject,
      resumedSubject: afterResume.record!.subject!,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function readBindings(path: string, source: string, record: string): { record: BindingRow | null; journals: JournalRow[] } {
  const database = new Database(path, { readonly: true });
  try {
    return {
      record: database
        .query('SELECT state, subject, bootstrap_key FROM binding_records WHERE source=? AND external_id=?')
        .get(source, record) as BindingRow | null,
      journals: database
        .query('SELECT key, bytes, acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key')
        .all(source, record) as JournalRow[],
    };
  } finally {
    database.close();
  }
}
