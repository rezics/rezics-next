import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { runImportCli } from '../../../importer/src/cli.ts';
import {
  createAccountTokenProvider,
  IMPORTER_SCOPES,
  CredentialDeniedError,
} from '../../../importer/src/credentials.ts';
import type { Importer } from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Phase = 'pending' | 'retired' | 'resumed' | 'unchanged';
type SignIn = { phase: Phase; status: number; kid: string; account: string; client: string; scopes: string[] };
type Token = { phase: Phase; status: number; account?: string; client?: string; scopes?: string[] };
type Write = { phase: Phase; path: string; bytes: string; key: string | null; status: number; body: unknown };
type Receipt = { key: string; transaction_id: string; response: unknown; xmin: string };

/** Only source/HTTP boundaries and response-loss timing are controlled here. */
export async function runCliKeyRotationJourney() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  let secrets: string | undefined;
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (secrets) await rm(secrets, { recursive: true, force: true });
    }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'imports-key-rotation-'));
    secrets = await mkdtemp('/dev/shm/imports-key-rotation-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(secrets, 'account.jwk');
    const identity = runtime.identity;
    const native = identitySupport(identity);
    const observer = await openApiObserver(runtime);
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const api = 'https://kernel.import.test';
    const owner = { source: 'bangumi', external_id: '987651' };
    const sourceUrl = 'https://lain.bgm.tv/pic/cover/l/ab/cd/key_rotation_fixture.jpg';
    const source = {
      id: Number(owner.external_id),
      type: 2,
      name: 'The Rotating Observatory',
      summary: 'A synthetic watchmaker catalogue entry for operator recovery.',
      images: { large: sourceUrl },
    };
    const input = new TextEncoder().encode(JSON.stringify(source) + '\n');
    await runtime.mediaBoundary.source(sourceUrl);

    async function credential(
      credential: Parameters<typeof identity.auth.internal.stageCredentialEffect>[0]['credential'],
    ) {
      await native.renewManagement();
      const staged = await identity.auth.internal.stageCredentialEffect({
        key: randomUUID(),
        subjectAccountId: identity.bulk.accountId,
        headers: native.managementHeaders,
        credential,
      });
      const effect = {
        key: staged.key,
        effectRef: staged.effectRef,
        subjectAccountId: identity.bulk.accountId,
        headers: native.managementHeaders,
      };
      const approval = await identity.auth.internal.approveCredentialEffect(effect);
      await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    }
    async function provision() {
      const pair = await generateKeyPair('ES256', { extractable: true });
      const kid = randomUUID();
      await credential({ kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } });
      return { kid, privateJwk: { ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' } };
    }
    const old = await provision();
    await writeFile(keyPath, JSON.stringify(old.privateJwk), { mode: 0o600 });
    let phase: Phase = 'pending';
    let controller = new AbortController();
    let consumed = 0;
    let sealedInputBytes = 0;
    let lost: { request: Request; bytes: string; result: BatchWriteResult } | undefined;
    const signIns: SignIn[] = [];
    const tokens: Token[] = [];
    const writes: Write[] = [];
    const commands = new Map<string, BatchCommand>();
    const coordinator: { converter: string; decoder: string; revision: string }[] = [];
    const keyReads: { phase: Phase; path: string; mode: number; regularFile: boolean }[] = [];
    const drained = new Set<string>();
    let currentImporter: Importer | undefined;
    const seals: unknown[] = [];
    const fences: unknown[] = [];

    const upstream = (async (requestInput: Request | string | URL, init?: RequestInit) => {
      const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init);
      const url = new URL(request.url);
      if (url.origin === auth) {
        expect(['/signin/key', '/token', '/.well-known/jwks.json']).toContain(url.pathname);
        const response = await native.host.service.handler(request);
        if (url.pathname === '/signin/key') {
          const body = await request.clone().json();
          signIns.push({
            phase,
            status: response.status,
            kid: decodeProtectedHeader(body.assertion).kid!,
            account: body.account_id,
            client: body.client_id,
            scopes: body.scope,
          });
        } else if (url.pathname === '/token') {
          const body = await response.clone().json();
          const claims = body.access_token ? decodeJwt(body.access_token) : undefined;
          tokens.push({
            phase,
            status: response.status,
            ...(claims
              ? {
                  account: claims.sub,
                  client: String(claims.client_id),
                  scopes: String(claims.scope).split(' ').sort(),
                }
              : {}),
          });
        }
        return response;
      }
      expect(url.origin).toBe(api);
      expect(request.headers.has('cookie')).toBe(false);
      // Real registered worker delivery at the actual returned reservation anchor.
      const media = /^\/v1\/media\/([^/:]+):importStatus$/.exec(url.pathname);
      if (media && !drained.has(media[1]!)) {
        await runtime.mediaBoundary.drain({ mediaIds: [media[1]!], maxJobs: 16, signal: controller.signal });
        drained.add(media[1]!);
      }
      const bytes = request.method === 'POST' ? await request.clone().text() : '';
      const isBatch = url.pathname === '/v1/subjects:batchWrite';
      if (isBatch) {
        const store = currentImporter!.session.store;
        const run = store.activeRun(owner.source)!;
        const seal = store.database
          .query('SELECT status,supplied,invalid FROM run_generations WHERE source=? AND id=?')
          .get(run.source, run.id);
        expect(seal).toMatchObject({ status: 'ready', supplied: 1, invalid: 0 });
        seals.push(seal);
        expect(consumed).toBe(input.byteLength);
        const body = JSON.parse(bytes) as BatchWriteRequest;
        for (const command of body.commands) {
          expect(command.source.source).toBe(owner.source);
          expect(command.source.external_id).toBe(owner.external_id);
          const prior = commands.get(command.key);
          if (prior) expect(command).toEqual(prior);
          commands.set(command.key, command);
          runtime.commands.set(command.key, { command, actor: identity.bulk.accountId });
        }
      }
      const replay = request.clone();
      const response = await runtime.replay(request);
      const body = await response.clone().json();
      if (url.pathname === '/v1/sourceFences:check')
        fences.push({ phase, request: JSON.parse(bytes), status: response.status, body });
      if (request.method !== 'GET' && url.pathname !== '/v1/sourceFences:check')
        writes.push({
          phase,
          path: url.pathname,
          bytes,
          key: request.headers.get('idempotency-key'),
          status: response.status,
          body,
        });
      if (phase === 'pending' && isBatch && !lost) {
        const batch = JSON.parse(bytes) as BatchWriteRequest;
        if (batch.commands.every((c) => c.op !== 'create')) {
          expect(response.status).toBe(200);
          const result = body as BatchWriteResult;
          expect(result.results).toHaveLength(batch.commands.length);
          for (const ack of result.results) expect('value' in ack).toBe(true);
          lost = { request: replay, bytes, result };
          controller.abort(new DOMException('Committed response lost', 'AbortError'));
          throw controller.signal.reason;
        }
      }
      return response;
    }) as typeof fetch;

    // Import the old key before replacing its file, then ask real Auth to use it after retirement.
    const retiredKey = await createAccountTokenProvider({
      accountKeyPath: keyPath,
      account: identity.bulk.accountId,
      client: identity.client.clientId,
      authOrigin: auth,
      fetch: upstream,
    });
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
      identity.bulk.accountId,
      '--client',
      identity.client.clientId,
    ];
    async function invoke(next: Phase) {
      phase = next;
      controller = new AbortController();
      let invocationBytes = 0;
      const result = await runImportCli(argv, {
        stdin: (async function* () {
          invocationBytes += input.byteLength;
          consumed += input.byteLength;
          yield input;
        })(),
        signal: controller.signal,
        fetch: upstream,
        observer: {
          onAccountKey(path, observation) {
            keyReads.push({ phase, path, mode: observation.mode, regularFile: observation.regularFile });
            expect(observation.mode).toBe(0o600);
            expect(observation.regularFile).toBe(true);
            expect(observation.importedKey.extractable).toBe(false);
          },
          onCoordinator({ importer, registration, converterModule, decoderModule }) {
            currentImporter = importer;
            coordinator.push({
              converter: converterModule,
              decoder: decoderModule,
              revision: registration.converter_revision,
            });
            // Observe the real maintained seal immediately before the first public effect.
            const active = importer.session.store.activeRun(owner.source);
            if (active) expect(active.source).toBe(owner.source);
          },
        },
      });
      expect(result.openHandles).toBe(0);
      expect(result.stderr).not.toContain('Bearer ');
      expect(result.stderr).not.toContain(old.privateJwk.d!);
      expect(invocationBytes).toBe(next === 'resumed' ? 0 : input.byteLength);
      if (next === 'pending') sealedInputBytes = invocationBytes;
      return result;
    }
    function inspect() {
      const session = new ImportSession(state);
      try {
        const run = session.store.activeRun(owner.source);
        const claim = session.bindings.claim(owner);
        const envelopes = run ? session.store.pagePending(run, { limit: 100 }) : [];
        return {
          run,
          claim,
          envelopes,
          source: session.store.source(owner.source),
          records: session.store.pageAcknowledged(owner.source, { limit: 8 }),
          bootstrap: [...commands.values()]
            .filter((c) => c.op === 'create')
            .map((c) => session.bindings.journal(owner, c.key)),
          mediaIds: session.bindings.mediaIds(owner),
          mediaJournal: session.store.database
            .query(
              'SELECT key,bytes,signature,accepted,status FROM binding_media WHERE source=? AND external_id=? ORDER BY key LIMIT 8',
            )
            .all(owner.source, owner.external_id),
          bootstrapAcknowledgements: [...commands.values()]
            .filter((c) => c.op === 'create')
            .map((c) =>
              session.store.database
                .query('SELECT acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
                .get(owner.source, owner.external_id, c.key),
            ),
        };
      } finally {
        session.close();
      }
    }
    async function receipts(keys: readonly string[]) {
      const rows: Receipt[] = [];
      for (const key of keys) {
        const command = commands.get(key)!;
        const route =
          command.op === 'create'
            ? tupleRoute(identity.routeKey, command.source.source, command.source.external_id)
            : routeOf(command.subject)!;
        const result = await runtime.database.admin.query<Omit<Receipt, 'key'>>(
          'SELECT transaction_id,response,xmin::text FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', identity.bulk.accountId, `subject.batch_${command.op}`, key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key, ...result.rows[0]! });
      }
      return rows;
    }
    const pending = await invoke('pending');
    if (!lost) throw new Error('No native committed proposal response was lost');
    const before = inspect();
    expect(before.run).not.toBeNull();
    expect(before.claim?.state).toBe('bound');
    expect(before.envelopes.length).toBeGreaterThan(0);
    expect(before.envelopes.map((e) => e.bytes)).toContain(lost.bytes);
    expect(before.bootstrap).toHaveLength(1);
    const originalKeys = [...commands.keys()];
    const originalReceiptRowsBefore = await receipts(originalKeys);
    const originalPreparedBytes = before.envelopes.map((e) => e.bytes);
    const originalPreparedKeys = before.envelopes.map((e) => e.keys);
    const subject = before.claim?.state === 'bound' ? before.claim.subject : undefined;
    if (!subject) throw new Error('Missing native subject binding');
    const publicBefore = await observer.http(`/v1/subjects/${subject}`);
    expect(publicBefore.status).toBe(200);
    const candidatesBefore = await runtime.database.admin.query<{ candidate_id: string; xmin: string }>(
      'SELECT candidate_id,xmin::text FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
      [routeOf(subject), subject],
    );
    expect(candidatesBefore.rows.length).toBeGreaterThan(0);
    const mediaId = before.mediaIds.cover;
    if (!mediaId) throw new Error('Missing actual cover reservation');
    const mediaBefore = await runtime.mediaBoundary.observe(mediaId);
    expect(mediaBefore.row.state).toBe('available');
    const mediaWrite = writes.find((w) => w.path === '/v1/media:importFromUrl');
    expect(mediaWrite).toBeDefined();

    await native.renewManagement();
    await identity.setBulkPermission(false);
    const denial = await runtime.replay(lost.request.clone());
    const denialBody = await denial.json();
    // Select success content from the actual denied response; absent content stays null.
    const revokedReplay = { status: denial.status, storedSuccess: denialBody.results ?? null };
    expect(denialBody).not.toEqual(lost.result);
    expect(await receipts(originalKeys)).toEqual(originalReceiptRowsBefore);

    const fresh = await provision();
    await writeFile(keyPath, JSON.stringify(fresh.privateJwk), { mode: 0o600 });
    await credential({ kind: 'key', kid: old.kid, remove: true });
    phase = 'retired';
    await expect(retiredKey(true)).rejects.toBeInstanceOf(CredentialDeniedError);
    await native.renewManagement();
    await identity.setBulkPermission(true);
    const resumed = await invoke('resumed');
    const after = inspect();
    expect(after.run).toBeNull();
    expect(after.claim).toEqual(before.claim);
    expect(after.bootstrap).toEqual(before.bootstrap);
    expect(after.mediaIds).toEqual(before.mediaIds);
    expect(after.mediaJournal).toEqual(before.mediaJournal);
    expect(after.bootstrapAcknowledgements).toEqual(before.bootstrapAcknowledgements);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]!.recordRevision).toBe('unversioned');
    expect(after.records[0]!.converter_revision).toBe(coordinator[0]!.revision);
    expect(after.records[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    const resumedWrites = writes.filter((w) => w.phase === 'resumed' && w.path === '/v1/subjects:batchWrite');
    const resumedPreparedBytes = resumedWrites.map((w) => w.bytes);
    const resumedPreparedKeys = resumedWrites.map((w) =>
      (JSON.parse(w.bytes) as BatchWriteRequest).commands.map((c) => c.key),
    );
    const originalReceiptRowsAfter = await receipts(originalKeys);
    const candidatesAfter = await runtime.database.admin.query<{ candidate_id: string; xmin: string }>(
      'SELECT candidate_id,xmin::text FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100',
      [routeOf(subject), subject],
    );
    // An actual extra/rewritten candidate is a duplicate effect witness.
    const duplicateEffectRows = candidatesAfter.rows.filter(
      (row) =>
        !candidatesBefore.rows.some((prior) => prior.candidate_id === row.candidate_id && prior.xmin === row.xmin),
    );
    expect(candidatesAfter.rows).toEqual(candidatesBefore.rows);
    expect(await runtime.mediaBoundary.observe(mediaId)).toEqual(mediaBefore);
    expect(await observer.http(`/v1/subjects/${subject}`)).toMatchObject({ status: 200, body: publicBefore.body });
    const unchanged = await invoke('unchanged');
    const unchangedPublicWrites = writes.filter((w) => w.phase === 'unchanged');
    expect(inspect().source?.present_count).toBe(1);
    expect(inspect().records).toEqual(after.records);
    expect(await receipts(originalKeys)).toEqual(originalReceiptRowsBefore);
    const firstSignIn = signIns.find((s) => s.phase === 'pending')!;
    const oldKeySignIn = signIns.find((s) => s.phase === 'retired')!;
    const newKeySignIn = signIns.find((s) => s.phase === 'resumed')!;
    const firstToken = tokens.find((t) => t.phase === 'pending')!;
    const newToken = tokens.find((t) => t.phase === 'resumed')!;
    expect(firstToken.scopes).toEqual([...IMPORTER_SCOPES].sort());
    expect(firstSignIn.scopes).toEqual([...IMPORTER_SCOPES]);
    expect(newKeySignIn.scopes).toEqual(firstSignIn.scopes);
    const jwks = await identity.auth.handler(new Request(identity.auth.verifier.jwksUrl));
    expect(jwks.status).toBe(200);
    expect((await jwks.json()).keys.length).toBeGreaterThan(0);
    const worker = await runtime.mediaBoundary.capture();
    expect(worker.executedJobs).toBeGreaterThan(0);
    expect(worker.liveInternetRequests).toEqual([]);
    console.log(
      'CLI key rotation native evidence',
      JSON.stringify({
        source: owner,
        inputBytes: sealedInputBytes,
        inputSha256: createHash('sha256').update(input).digest('hex'),
        coordinator,
        bundle: { catalogue: bundledRelease.catalogue, digest: bundledDigest },
        seals,
        fences,
        signIns,
        tokens,
        keyReads,
        run: before.run,
        sourceAfter: after.source,
        records: after.records,
        prepared: before.envelopes,
        receipts: originalReceiptRowsAfter,
        mediaWrite,
        subject,
        candidates: candidatesAfter.rows,
        media: mediaBefore,
        worker: {
          jobs: worker.executedJobs,
          calls: worker.calls,
          registrations: worker.registrations.map((r) => r.name),
        },
        revokedReplay,
        resumed: { code: resumed.code },
        unchanged: { code: unchanged.code, writes: unchangedPublicWrites.length },
      }),
    );
    return {
      pending,
      oldKeyId: firstSignIn.kid,
      newKeyId: newKeySignIn.kid,
      accountBefore: firstToken.account,
      accountAfter: newToken.account,
      clientBefore: firstToken.client,
      clientAfter: newToken.client,
      oldKeySignIn,
      newKeySignIn,
      newToken,
      originalScopes: firstToken.scopes,
      newScopes: newToken.scopes,
      revokedReplay,
      resumed,
      resumedPreparedBytes,
      originalPreparedBytes,
      resumedPreparedKeys,
      originalPreparedKeys,
      originalReceiptRowsAfter,
      originalReceiptRowsBefore,
      duplicateEffectRows,
      unchanged,
      unchangedPublicWrites,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
