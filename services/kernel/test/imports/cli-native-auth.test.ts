import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

// Basic credential and permission matrices remain in their existing suites.
test('the real CLI account-key and public-write journey is frozen against native Auth and Access', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  let secrets: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'imports-cli-native-'));
    secrets = await mkdtemp('/dev/shm/imports-cli-key-');
    const f = runtime.identity;
    const native = identitySupport(f);
    const observer = await openApiObserver(runtime);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await f.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: f.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: f.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await f.auth.internal.approveCredentialEffect(effect);
    await f.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    const keyPath = join(secrets, 'account.jwk');
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
    });
    const api = 'https://kernel.import.test';
    const auth = new URL(f.auth.verifier.jwksUrl).origin;
    const state = join(directory, 'state.sqlite');
    const argv = [
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
      f.bulk.accountId,
      '--client',
      f.client.clientId,
    ];
    const commands = new Map<string, BatchCommand>();
    const exchanges: { body: BatchWriteRequest; status: number; result: unknown }[] = [];
    const authPaths: string[] = [];
    let inputPasses = 0;
    let inputBytes = 0;
    const invoke = async (title: string, acquisition: 'fresh' | 'resume' = 'fresh') => {
      const bytes = new TextEncoder().encode(JSON.stringify({ id: 987654, type: 2, name: title }) + '\n');
      let consumed = 0;
      const result = await runImportCli(argv, {
        stdin: (async function* () {
          consumed += bytes.length;
          yield bytes;
        })(),
        observer: {
          onInputPass() {
            inputPasses++;
          },
          onInputChunk(_kind, size) {
            inputBytes += size;
          },
          onAccountKey(_path, observation) {
            expect(observation.regularFile).toBe(true);
            expect(observation.mode & 0o777).toBe(0o600);
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === auth) {
            expect(['/signin/key', '/token', '/.well-known/jwks.json']).toContain(url.pathname);
            authPaths.push(url.pathname);
            if (url.pathname === '/signin/key') {
              const body = await request.clone().json();
              expect(body.account_id).toBe(f.bulk.accountId);
              expect(body.client_id).toBe(f.client.clientId);
              expect(body.scope).toEqual([...IMPORTER_SCOPES]);
              expect(decodeJwt(body.assertion).sub).toBe(f.bulk.accountId);
            }
            const response = await native.host.service.handler(request);
            if (!response.ok)
              console.log(
                'native CLI Auth denial',
                JSON.stringify({
                  path: url.pathname,
                  status: response.status,
                  problem: await response.clone().text(),
                }),
              );
            return response;
          }
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          expect(url.pathname === '/v1/subjects:batchWrite' || url.pathname === '/v1/sourceFences:check').toBe(true);
          const bearer = request.headers.get('authorization')!;
          expect(bearer.startsWith('Bearer ')).toBe(true);
          const claims = decodeJwt(bearer.slice(7));
          expect(claims.sub).toBe(f.bulk.accountId);
          expect(claims.client_id).toBe(f.client.clientId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          if (url.pathname !== '/v1/subjects:batchWrite') return runtime.replay(request);
          const body = (await request.clone().json()) as BatchWriteRequest;
          for (const command of body.commands) {
            const prior = commands.get(command.key);
            if (prior) expect(command).toEqual(prior);
            commands.set(command.key, command);
          }
          const response = await runtime.replay(request);
          exchanges.push({ body, status: response.status, result: await response.clone().json() });
          return response;
        }) as typeof fetch,
      });
      const diagnostic = JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr });
      expect(result.openHandles, diagnostic).toBe(0);
      expect(consumed, diagnostic).toBe(acquisition === 'resume' ? 0 : bytes.length);
      return result;
    };
    const inspect = () => {
      const session = new ImportSession(state);
      try {
        const owner = { source: 'bangumi', external_id: '987654' };
        const run = session.store.activeRun('bangumi');
        return {
          subject: session.bindings.claim(owner),
          source: session.store.source('bangumi'),
          active: run,
          pending: run ? session.store.pagePending(run, { limit: 100 }) : [],
        };
      } finally {
        session.close();
      }
    };
    const effects = async (subject: string) => {
      const route = routeOf(subject)!;
      const subjects = await runtime.database.admin.query(
        'SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2',
        [route, subject],
      );
      const candidates = await runtime.database.admin.query(
        'SELECT candidate.candidate_id,candidate.statement,retraction.revision AS retracted FROM semantic.candidate candidate LEFT JOIN LATERAL (SELECT revision FROM semantic.retraction WHERE route=candidate.route AND subject_id=candidate.subject_id AND candidate_id=candidate.candidate_id ORDER BY revision DESC LIMIT 1) retraction ON true WHERE candidate.route=$1 AND candidate.subject_id=$2 ORDER BY candidate.candidate_id LIMIT 100',
        [route, subject],
      );
      const receipts = [];
      for (const [key, command] of commands) {
        const commandRoute =
          command.op === 'create'
            ? tupleRoute(f.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(commandRoute), 'account', f.bulk.accountId, `subject.batch_${command.op}`, key],
        );
        for (const row of result.rows) receipts.push({ key, ...row });
      }
      return { subjects: subjects.rows, candidates: candidates.rows, receipts };
    };
    const first = await invoke('Native CLI title');
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    const initial = inspect();
    expect(initial.subject?.state).toBe('bound');
    if (initial.subject?.state !== 'bound') throw new Error('CLI did not bind its native subject');
    const subject = initial.subject.subject;
    expect(initial.active).toBeNull();
    const persisted = await effects(subject);
    expect(persisted.subjects).toHaveLength(1);
    expect(persisted.candidates.length).toBeGreaterThan(0);
    expect(persisted.receipts.length).toBe(commands.size);
    const disclosed = await observer.http(`/v1/subjects/${subject}`);
    expect(disclosed.status).toBe(200);
    expect((disclosed.body.subject as { id: string }).id).toBe(subject);
    for (const exchange of exchanges) {
      expect(exchange.status).toBe(200);
      expect((exchange.result as BatchWriteResult).results.every((entry) => entry.status < 300)).toBe(true);
    }
    const unchanged = await invoke('Native CLI title');
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toContain('unchanged=1');
    expect(inspect().subject).toEqual(initial.subject);
    expect(await effects(subject)).toEqual(persisted);
    await native.renewManagement();
    await f.setBulkPermission(false);
    const denialStart = exchanges.length;
    const denied = await invoke('Changed native CLI title');
    expect(denied.code).toBe(4);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('authorization was denied');
    const deniedWrites = exchanges.slice(denialStart);
    expect(deniedWrites.length).toBeGreaterThan(0);
    expect(deniedWrites.some((entry) => entry.status === 403)).toBe(true);
    expect(await effects(subject)).toEqual(persisted);
    const pending = inspect();
    expect(pending.source).toEqual(initial.source);
    expect(pending.active).not.toBeNull();
    expect(pending.pending.length).toBeGreaterThan(0);
    const deniedKeys = deniedWrites.flatMap((entry) => entry.body.commands.map((command) => command.key));
    console.log('native CLI denial', JSON.stringify(deniedWrites.map(({ status, result }) => ({ status, result }))));
    await native.renewManagement();
    await f.setBulkPermission(true);
    const recoveryStart = exchanges.length;
    const recovered = await invoke('Changed native CLI title', 'resume');
    expect(recovered.code, JSON.stringify(recovered)).toBe(0);
    const recoveryKeys = exchanges
      .slice(recoveryStart)
      .flatMap((entry) => entry.body.commands.map((command) => command.key));
    for (const key of deniedKeys) expect(recoveryKeys).toContain(key);
    expect(inspect().active).toBeNull();
    expect(inspect().subject).toEqual(initial.subject);
    const final = await effects(subject);
    expect(final.subjects).toEqual(persisted.subjects);
    expect(final.receipts.length).toBeGreaterThan(persisted.receipts.length);
    expect(final.candidates.some((row) => JSON.stringify(row.statement).includes('Changed native CLI title'))).toBe(
      true,
    );
    expect(authPaths.filter((path) => path === '/signin/key')).toHaveLength(4);
    expect(authPaths.filter((path) => path === '/token')).toHaveLength(4);
    // Access verifies the actual issued bearers against native Auth's configured JWKS handler.
    expect((await f.auth.handler(new Request(f.auth.verifier.jwksUrl))).status).toBe(200);
    expect(inputPasses).toBe(3);
    expect(inputBytes).toBe(
      ['Native CLI title', 'Native CLI title', 'Changed native CLI title']
        .map((name) => new TextEncoder().encode(JSON.stringify({ id: 987654, type: 2, name }) + '\n').length)
        .reduce((sum, bytes) => sum + bytes, 0),
    );
    console.log(
      'native CLI evidence',
      JSON.stringify({
        inputPasses,
        inputBytes,
        commands: commands.size,
        subjects: final.subjects.length,
        candidates: final.candidates.length,
        receipts: final.receipts.length,
      }),
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (secrets) await rm(secrets, { recursive: true, force: true });
    }
  }
}, 120000);
