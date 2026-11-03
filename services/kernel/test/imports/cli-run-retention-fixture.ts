import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '../../../../packages/conversion/src/bangumi.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const jsonl = (record: unknown) => `${JSON.stringify(record)}\n`;
const bangumi = { id: 424244, type: 2, name: 'The Retention Observatory' };
const second = { ...bangumi, name: 'The Completed Retention Observatory' };
const third = { ...bangumi, name: 'The Recoverable Retention Observatory' };

export async function runCliRunRetentionJourney() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'import-cli-retention-'));
    const state = join(directory, 'state.sqlite');
    const planPath = join(directory, 'retention.json');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
    const native = identitySupport(runtime.identity);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await runtime.identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: runtime.identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const api = 'https://cli-retention.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const commands = new Map<string, BatchCommand>();
    const writes: { bytes: string; keys: string[] }[] = [];

    function facts(path: string) {
      const db = new Database(path, { readonly: true });
      try {
        return {
          generations: db
            .query('SELECT id,status FROM run_generations WHERE source=? ORDER BY seq')
            .all('bangumi') as { id: string; status: string }[],
          source: db.query('SELECT generation,lease_run,present_count,sequence FROM run_sources WHERE source=?').get('bangumi') as {
            generation: string | null;
            lease_run: string | null;
            present_count: number;
            sequence: number;
          },
          ack: db.query('SELECT record_key,row_json FROM run_acknowledged WHERE source=? ORDER BY record_key').all('bangumi'),
          payloads: db.query('SELECT command_key,body FROM run_payloads WHERE source=? ORDER BY command_key').all('bangumi'),
        };
      } finally {
        db.close();
      }
    }

    async function invoke(text: string, lose = false) {
      const controller = new AbortController();
      const captured: { bytes: string; keys: string[] }[] = [];
      const result = await runImportCli(
        [
          '--source',
          'bangumi',
          '--dump',
          '-',
          '--state',
          state,
          '--api',
          api,
          '--auth',
          auth,
          '--account-key',
          keyPath,
          '--account',
          runtime.identity.bulk.accountId,
          '--client',
          runtime.identity.client.clientId,
        ],
        {
          signal: controller.signal,
          stdin: (async function* () {
            yield new TextEncoder().encode(text);
          })(),
          observer: {
            onCoordinator({ registration, converterModule }) {
              expect(registration.source).toBe('bangumi');
              expect(registration.converter_revision).toBe(bangumiRevision);
              expect(converterModule).toContain('bangumi');
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) return native.host.service.handler(request);
            expect(url.origin).toBe(api);
            const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
            expect(claims.sub).toBe(runtime.identity.bulk.accountId);
            expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
            const bytes = request.method === 'GET' ? '' : await request.clone().text();
            const bulk = url.pathname === '/v1/subjects:batchWrite';
            const body = bulk ? (JSON.parse(bytes) as BatchWriteRequest) : null;
            for (const command of body?.commands ?? []) {
              const previous = commands.get(command.key);
              if (previous) expect(command).toEqual(previous);
              commands.set(command.key, command);
            }
            const response = await runtime.replay(request);
            expect(response.status, await response.clone().text()).toBeLessThan(300);
            if (bulk) {
              captured.push({ bytes, keys: body!.commands.map((command) => command.key) });
              writes.push(captured.at(-1)!);
              if (lose && body!.commands.some((command) => command.op === 'propose')) {
                controller.abort(new DOMException('Interrupted after native commit before local ACK', 'AbortError'));
                throw controller.signal.reason;
              }
            }
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.openHandles).toBe(0);
      return { ...result, captured };
    }

    const first = await invoke(jsonl(bangumi));
    expect(first.code).toBe(0);
    const secondRun = await invoke(jsonl(second));
    expect(secondRun.code).toBe(0);
    const interrupted = await invoke(jsonl(third), true);
    expect([1, 130]).toContain(interrupted.code);
    const before = facts(state);
    const superseded = before.generations.find((row) => row.status === 'complete' && row.id !== before.source.generation);
    expect(superseded).toBeDefined();
    let network = 0;
    const fetchBoundary = (async () => {
      network++;
      throw new Error('retention must not use the network');
    }) as unknown as typeof fetch;
    const listed = await runImportCli(['retention', '--state', state, '--source', 'bangumi', '--json'], {
      fetch: fetchBoundary,
    });
    expect(listed.code).toBe(0);
    const list = JSON.parse(listed.stdout) as { baseline: string; active: string; generations: { id: string; eligible: boolean }[] };
    expect(list.baseline).toBe(before.source.generation);
    expect(list.active).toBe(before.source.lease_run);
    expect(list.generations.find((row) => row.id === superseded!.id)?.eligible).toBe(true);
    const planned = await runImportCli(
      ['retention', '--state', state, '--source', 'bangumi', '--generation', superseded!.id, '--output', planPath, '--json'],
      { fetch: fetchBoundary },
    );
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout) as { planId: string };
    const applied = await runImportCli(
      ['retention', '--state', state, '--plan', planPath, '--confirm', plan.planId, '--apply', '--json'],
      { fetch: fetchBoundary },
    );
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ status: 'complete', retired: [superseded!.id] });
    expect(network).toBe(0);
    const inspect = await runImportCli([
      'inspect',
      '--state',
      state,
      '--source',
      'bangumi',
      '--generation',
      superseded!.id,
      '--json',
    ]);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).generation.status).toBe('retired');
    const diagnostics = await runImportCli([
      'diagnostics',
      '--state',
      state,
      '--source',
      'bangumi',
      '--generation',
      superseded!.id,
      '--format',
      'json',
    ]);
    expect(diagnostics.code).toBe(0);
    expect(JSON.parse(diagnostics.stdout).coverage).toBe('unavailable');
    const resumed = await invoke(jsonl(third));
    expect(resumed.code).toBe(0);
    const after = facts(state);
    expect(after.payloads).toEqual(before.payloads);
    expect(after.source.generation).toBe(before.source.lease_run);
    const session = new ImportSession(state);
    let subjectId = '';
    try {
      const claim = session.bindings.claim({ source: 'bangumi', external_id: String(bangumi.id) });
      expect(claim?.state).toBe('bound');
      if (claim?.state === 'bound') subjectId = claim.subject;
    } finally {
      session.close();
    }
    return {
      listed,
      applied,
      inspect,
      diagnostics,
      interrupted,
      resumed,
      network,
      subjectId,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
