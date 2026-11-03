import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '../../../../packages/conversion/src/bangumi.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Importer } from '../../../importer/src/importer.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';

const jsonl = (record: unknown) => `${JSON.stringify(record)}\n`;
const bangumi = { id: 424243, type: 2, name: 'The Snapshot Observatory' };
const changed = { ...bangumi, name: 'The Interrupted Snapshot Observatory' };
const vanished = jsonl({ id: 1, type: 2, name: 'Unrelated remaining row' });

type Journal = { source: string; external_id: string; key: string; bytes: string; acknowledgement: string | null };

export async function runCliBackupRecoveryJourney() {
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
    directory = await mkdtemp(join(tmpdir(), 'import-cli-backup-'));
    const state = join(directory, 'state.sqlite');
    const restored = join(directory, 'restored.sqlite');
    const snapshot = join(directory, 'snapshot');
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
    const editor = await openApiObserver(runtime);
    const api = 'https://cli-backup.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const commands = new Map<string, BatchCommand>();
    const writes: { bytes: string; keys: string[]; status: number }[] = [];

    function inspect(path: string) {
      const session = new ImportSession(path);
      try {
        const active = session.store.activeRun('bangumi');
        return {
          source: session.store.source('bangumi'),
          active,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          record: session.store.key('bangumi', String(bangumi.id)),
          claim: session.bindings.claim({ source: 'bangumi', external_id: String(bangumi.id) }),
          journals: session.store.database
            .query<Journal, [string, string]>(
              'SELECT source,external_id,key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
            )
            .all('bangumi', String(bangumi.id)),
        };
      } finally {
        session.close();
      }
    }

    async function receipts(keys: readonly string[]) {
      const result = [];
      for (const key of keys) {
        const command = commands.get(key)!;
        const route =
          command.op === 'create'
            ? tupleRoute(runtime.identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const rows = (
          await runtime.database.admin.query(
            'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
            [partitionOf(route), 'account', runtime.identity.bulk.accountId, `subject.batch_${command.op}`, key],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        result.push({ key, rows });
      }
      return result;
    }

    async function invoke(path: string, text: string, lose = false) {
      const controller = new AbortController();
      let coordinator: Importer | undefined;
      const captured: { bytes: string; keys: string[]; status: number }[] = [];
      const result = await runImportCli(
        [
          '--source',
          'bangumi',
          '--dump',
          '-',
          '--state',
          path,
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
            onCoordinator({ importer, registration, converterModule }) {
              coordinator = importer;
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
            const responseBytes = await response.clone().text();
            expect(response.status, responseBytes).toBeLessThan(300);
            if (bulk) {
              captured.push({ bytes, keys: body!.commands.map((command) => command.key), status: response.status });
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
      expect(coordinator).toBeDefined();
      return { ...result, captured };
    }

    const initial = await invoke(state, jsonl(bangumi));
    expect(initial.code).toBe(0);
    const local = inspect(state);
    expect(local.claim?.state).toBe('bound');
    if (local.claim?.state !== 'bound') throw new Error('Native CLI did not bind its exact source');
    const id = local.claim.subject;
    const contextResponse = await editor.http('/v1/contexts', { labels: { en: 'Snapshot recovery review' } });
    expect(contextResponse.status).toBe(201);
    const context = (contextResponse.body.context as { id: string }).id;
    const listed = await editor.http(
      `/v1/subjects/${id}/candidates?${new URLSearchParams({ property: 'schema:name', context, limit: '100' })}`,
    );
    expect(listed.status).toBe(200);
    const candidate = (listed.body.candidates as unknown as { id: string; source: { source: string }; statement: BatchStatement }[])[0]!;
    expect(candidate.source.source).toBe('bangumi');
    expect(
      (await editor.http(`/v1/subjects/${id}/candidates/${candidate.id}:accept`, { context, expected_head: null })).status,
    ).toBe(200);
    expect(
      (
        await editor.http(`/v1/subjects/${id}:adopt`, {
          context,
          property: 'schema:name',
          mode: 'replace',
          expected_head: null,
          selection: [{ candidate: candidate.id, rank: 'normal' }],
        })
      ).status,
    ).toBe(200);
    const selected = await runtime.request(`/v1/subjects/${id}?context=${context}`);
    expect(selected.status).toBe(200);
    const interrupted = await invoke(state, jsonl(changed), true);
    expect([1, 130]).toContain(interrupted.code);
    const pending = inspect(state);
    expect(pending.pending).toHaveLength(1);
    expect(pending.record.acknowledged).toEqual(local.record.acknowledged);
    const pendingBytes = pending.pending[0]!.bytes;
    const pendingKeys = pending.pending[0]!.keys;
    expect(pendingBytes).toBe(interrupted.captured.at(-1)!.bytes);
    const wal = `${state}-wal`;
    const held = new Database(state);
    let backup: Awaited<ReturnType<typeof runImportCli>>;
    try {
      held.exec('PRAGMA wal_autocheckpoint=0');
      held.exec('CREATE TABLE IF NOT EXISTS extra_compatible(note TEXT)');
      held.exec("INSERT INTO extra_compatible(note) VALUES('committed-wal')");
      backup = await runImportCli(['backup', '--state', state, '--output', snapshot, '--json']);
      expect(backup.code).toBe(0);
      expect(JSON.parse(backup.stdout).runs[0].source).toBe('bangumi');
    } finally {
      held.close();
    }
    const validated = await runImportCli(['validate-snapshot', '--snapshot', snapshot, '--json']);
    expect(validated.code).toBe(0);
    const restore = await runImportCli(['restore', '--snapshot', snapshot, '--state', restored]);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain(restored);
    const restoredPending = inspect(restored);
    expect(restoredPending.pending.map((row) => row.bytes)).toEqual([pendingBytes]);
    expect(restoredPending.pending.flatMap((row) => row.keys)).toEqual(pendingKeys);
    expect(new Database(restored, { readonly: true }).query("SELECT note FROM extra_compatible").all()).toEqual([
      { note: 'committed-wal' },
    ]);
    const resumed = await invoke(restored, jsonl(changed));
    expect(resumed.code).toBe(0);
    expect(resumed.captured.map((entry) => entry.bytes)).toEqual([pendingBytes]);
    expect(resumed.captured.flatMap((entry) => entry.keys)).toEqual(pendingKeys);
    const after = inspect(restored);
    expect(after.active).toBeNull();
    expect(after.pending).toEqual([]);
    const originalReceipts = await receipts(initial.captured.flatMap((entry) => entry.keys));
    expect(await receipts(originalReceipts.map((row) => row.key))).toEqual(originalReceipts);
    const readback = await runtime.request(`/v1/subjects/${id}?context=${context}`);
    expect(readback.status).toBe(200);
    const body = (await readback.json()) as { subject: { statements: Record<string, unknown[]> } };
    expect(body.subject.statements['schema:name']).toHaveLength(1);
    const listingAfter = await editor.http(
      `/v1/subjects/${id}/candidates?${new URLSearchParams({ property: 'schema:name', context, limit: '100' })}`,
    );
    const accepted = (listingAfter.body.candidates as unknown as { id: string; head: number | null }[]).filter(
      (entry) => entry.head !== null,
    );
    expect(accepted.some((entry) => entry.id === candidate.id)).toBe(true);
    const vanishedRun = await invoke(restored, vanished);
    expect(vanishedRun.code).toBe(3);
    expect(inspect(restored).record.baseline?.digest).toBe(after.record.baseline?.digest);
    return {
      interrupted,
      backup,
      validated,
      restore,
      resumed,
      pendingBytes,
      pendingKeys,
      replayedBytes: resumed.captured.map((entry) => entry.bytes),
      replayedKeys: resumed.captured.flatMap((entry) => entry.keys),
      subjectId: id,
      selectedCandidate: candidate.id,
      vanished: vanishedRun,
      walExisted: wal,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
