import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { Statement, Subject } from '../../../../specs/semantic-driver.ts';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { createImporter, type Importer } from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import type { Seal } from '../../../importer/src/run-store.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Leg = 'initial' | 'denied' | 'resumed' | 'successor';
type Exchange = {
  leg: Leg;
  ordinal: number;
  path: string;
  bytes: string;
  keys: string[];
  phase: string | null;
  status: number;
  response: string;
};
type Journal = { external_id: string; key: string; bytes: string; acknowledgement: string | null };
type MediaJournal = { external_id: string; key: string; bytes: string; accepted: string; status: string };
type Candidate = { id: string; statement: Statement };
const source = 'bangumi';
// Supplied synthetic metadata only. No provider posts or recipe text.
const initialRows = Array.from({ length: 17 }, (_, i) => ({
  id: 930001 + i,
  type: 2,
  name: `Authority observatory ${i + 1}`,
}));
const changedRows = initialRows.map((row, i) => ({
  ...row,
  name: `${row.name} refreshed`,
  ...(i === 0 ? { images: { large: 'https://lain.bgm.tv/cover.jpg' } } : {}),
}));
const successorRows = changedRows.map((row) => ({ ...row, name: `${row.name} successor` }));
const feed = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const firstRecord = String(initialRows[0]!.id);

/** Thin observation and request scheduling over one ordinary CLI/Auth/Access/worker world. */
export async function runJourney() {
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
    directory = await mkdtemp('/dev/shm/import-cli-authority-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'operator.jwk');
    await writeFile(state, '', { flag: 'wx', mode: 0o600 });
    const identity = runtime.identity;
    const native = identitySupport(identity);
    const editor = await openApiObserver(runtime);
    await native.renewManagement();
    const kid = randomUUID();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const staged = await identity.auth.internal.stageCredentialEffect({
      key: kid,
      subjectAccountId: identity.bulk.accountId,
      headers: native.managementHeaders,
      credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
    });
    const effect = {
      key: staged.key,
      effectRef: staged.effectRef,
      subjectAccountId: identity.bulk.accountId,
      headers: native.managementHeaders,
    };
    const approval = await identity.auth.internal.approveCredentialEffect(effect);
    await identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const api = 'https://cli-authority.import.test';
    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const commands = new Map<string, BatchCommand>();
    const revisions: { leg: Leg; source: string; converter: string }[] = [];
    const heldRequests: { bytes: string; keys: string[]; arrived: number }[] = [];
    // These credential-bearing Requests never enter logs, public results or assertion diagnostics.
    let successfulRequest: Request | undefined;
    let successfulExchange: Exchange | undefined;
    let firstForwarded = false;
    let revocation: { afterResponse: number; held: number; releasedAtMs: number } | undefined;
    const release = Promise.withResolvers<void>();
    const hasHeldRequest = Promise.withResolvers<void>();
    let ordinal = 0;
    let workerStarted = false;

    function inspect() {
      const session = new ImportSession(state);
      try {
        const active = session.store.activeRun(source);
        return {
          active,
          pending: active ? session.store.pagePending(active, { limit: 100 }) : [],
          completed: {
            source: session.store.source(source),
            rows: initialRows.map((row) => session.store.key(source, String(row.id)).baseline),
          },
          records: initialRows.map((row) => session.store.key(source, String(row.id))),
          claims: initialRows.map((row) => session.bindings.claim({ source, external_id: String(row.id) })),
          journals: initialRows.flatMap((row) =>
            session.store.database
              .query<Journal, [string, string]>(
                'SELECT external_id,key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
              )
              .all(source, String(row.id)),
          ),
          media: session.store.database
            .query<MediaJournal, [string, string]>(
              'SELECT external_id,key,bytes,accepted,status FROM binding_media WHERE source=? AND external_id=? ORDER BY key LIMIT 64',
            )
            .all(source, firstRecord),
        };
      } finally {
        session.close();
      }
    }

    async function receipts(keys: readonly string[]) {
      const rows = [];
      for (const key of keys) {
        const command = commands.get(key)!;
        const route = command.op === 'create'
          ? tupleRoute(identity.routeKey, source, command.source.external_id)
          : routeOf(command.subject)!;
        const result = await runtime.database.admin.query(
          'SELECT transaction_id,response,xmin::text FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [partitionOf(route), 'account', identity.bulk.accountId, `subject.batch_${command.op}`, key],
        );
        expect(result.rows).toHaveLength(1);
        rows.push({ key, ...result.rows[0]! });
      }
      return rows;
    }

    async function invoke(leg: Leg, text: string) {
      let consumed = 0;
      let ended = false;
      let sealed = false;
      let coordinator: Importer | undefined;
      const seals: Seal[] = [];
      const phases = new Map<string, string>();
      const authPaths: string[] = [];
      const start = exchanges.length;
      const result = await runImportCli([
        '--source', source, '--dump', '-', '--state', state, '--api', api,
        '--auth', auth, '--account-key', keyPath, '--account', identity.bulk.accountId,
        '--client', identity.client.clientId,
      ], {
        stdin: (async function* () {
          const bytes = new TextEncoder().encode(text);
          consumed += bytes.length;
          yield bytes;
          ended = true;
        })(),
        createImporter(options) {
          // Observe the existing default-width executor; do not replace or serialize it.
          options.observer = {
            onRecordActive(phase, recordKey, active) {
              if (active) phases.set(recordKey, phase);
              else phases.delete(recordKey);
            },
          };
          return createImporter(options);
        },
        observer: {
          onAccountKey(_path, observation) {
            expect(observation.regularFile).toBe(true);
            expect(observation.mode & 0o777).toBe(0o600);
            expect(observation.importedKey.extractable).toBe(false);
          },
          onCoordinator({ importer, registration, converterModule }) {
            coordinator = importer;
            revisions.push({ leg, source: registration.source, converter: registration.converter_revision });
            expect(registration.converter_revision).toBe(converter_revision);
            expect(converterModule).toBe(import.meta.resolve('../../../../packages/conversion/src/bangumi.ts'));
            const seal = importer.session.store.seal.bind(importer.session.store);
            importer.session.store.seal = (run, input) => {
              const result = seal(run, input);
              seals.push(result);
              sealed = result.status === 'ready';
              return result;
            };
            const active = importer.session.store.activeRun(source);
            if (active) sealed = importer.session.store.pagePending(active, { limit: 100 }).length > 0;
          },
        },
        fetch: (async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          expect(sealed).toBe(true);
          if (url.origin === auth) {
            authPaths.push(url.pathname);
            return native.host.service.handler(request);
          }
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(identity.bulk.accountId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          const bytes = request.method === 'GET' ? '' : await request.clone().text();
          const bulk = url.pathname === '/v1/subjects:batchWrite';
          const body = bulk ? JSON.parse(bytes) as BatchWriteRequest : null;
          for (const command of body?.commands ?? []) {
            expect(command.source.source).toBe(source);
            const prior = commands.get(command.key);
            if (prior) expect(command).toEqual(prior);
            commands.set(command.key, command);
          }
          const keys = body?.commands.map((command) => command.key) ?? [];
          const phase = body ? phases.get(body.commands[0]!.source.external_id) ?? null : null;
          const first = leg === 'denied' && bulk && !firstForwarded &&
            body!.commands.every((command) => command.source.external_id === firstRecord);
          if (first) firstForwarded = true;
          if (leg === 'denied' && bulk && !first) {
            // The actual request is held BEFORE Access sees it. Other records keep their native concurrency.
            heldRequests.push({ bytes, keys, arrived: Date.now() });
            hasHeldRequest.resolve();
            await release.promise;
          }
          const saved = first ? request.clone() : undefined;
          const response = await runtime.replay(request);
          const responseBytes = await response.clone().text();
          const exchange: Exchange = {
            leg, ordinal: ++ordinal, path: url.pathname, bytes, keys, phase,
            status: response.status, response: responseBytes,
          };
          exchanges.push(exchange);
          if (first) {
            expect(response.status, responseBytes).toBe(200);
            const results = (JSON.parse(responseBytes) as BatchWriteResult).results;
            for (const entry of results) expect('value' in entry, JSON.stringify(entry)).toBe(true);
            successfulRequest = saved;
            successfulExchange = exchange;
            try {
              await hasHeldRequest.promise;
              await native.renewManagement();
              await identity.setBulkPermission(false);
              revocation = { afterResponse: exchange.ordinal, held: heldRequests.length, releasedAtMs: Date.now() };
            } finally {
              release.resolve();
            }
          }
          if (url.pathname === '/v1/media:importFromUrl' && response.status === 202) {
            if (!workerStarted) {
              await runtime.mediaBoundary.start();
              workerStarted = true;
            }
            const accepted = JSON.parse(responseBytes) as { media: { id: string } };
            await runtime.mediaBoundary.drain({ mediaIds: [accepted.media.id], maxJobs: 16, signal: request.signal });
          }
          return response;
        }) as typeof fetch,
      });
      expect(result.openHandles).toBe(0);
      expect(phases.size).toBe(0);
      expect(coordinator).toBeDefined();
      expect(() => coordinator!.session.store.source(source)).toThrow();
      expect((await stat(state)).mode & 0o777).toBe(0o600);
      expect(authPaths).toEqual(['/signin/key', '/token']);
      if (leg === 'resumed') {
        expect(consumed).toBe(0);
        expect(seals).toEqual([]);
      } else {
        expect(ended).toBe(true);
        expect(consumed).toBe(Buffer.byteLength(text));
        expect(seals).toHaveLength(1);
        expect(seals[0]).toMatchObject({ status: 'ready', supplied: 17 });
      }
      return { ...result, consumed, seals, exchanges: exchanges.slice(start), inputSha256: sha256(text) };
    }

    async function nativeEffects(id: string) {
      const rows = [];
      for (const [kind, sql] of [
        ['subject', 'SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2'],
        ['candidate', 'SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id LIMIT 100'],
        ['retraction', 'SELECT * FROM semantic.retraction WHERE route=$1 AND subject_id=$2 ORDER BY revision,candidate_id LIMIT 100'],
        ['revision', 'SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 100'],
      ] as const) {
        const result = await runtime.database.admin.query(sql, [routeOf(id), id]);
        expect(result.rows.length).toBeLessThan(100);
        rows.push(...result.rows.map((row) => ({ kind, row })));
      }
      return rows;
    }

    const initial = await invoke('initial', feed(initialRows));
    expect(initial.code, initial.stderr).toBe(0);
    const before = inspect();
    const completedBaselineBefore = before.completed;
    expect(completedBaselineBefore.source.count).toBe(17);
    expect(before.active).toBeNull();
    expect(before.media).toEqual([]);
    const ids = before.claims.map((claim) => {
      expect(claim?.state).toBe('bound');
      if (claim?.state !== 'bound') throw new Error('Missing CLI source binding');
      return claim.subject;
    });
    // Create an independently authenticated community choice using retrieved source references.
    const id = ids[1]!;
    const listing = await editor.http(`/v1/subjects/${id}/candidates?property=schema:name&limit=100`);
    expect(listing.status).toBe(200);
    const imported = (listing.body.candidates as Candidate[])[0]!;
    const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Independent community observatory' } },
        references: imported.statement.references.map((reference) => ({
          parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
        })),
      },
    });
    expect(independent.status).toBe(201);
    const candidate = independent.body.candidate as string;
    const created = await editor.http('/v1/contexts', { labels: { en: 'Independent authority review' } });
    expect(created.status).toBe(201);
    const context = (created.body.context as { id: string }).id;
    expect((await editor.http(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null })).status).toBe(200);
    const current = await editor.http(`/v1/subjects/${id}/candidates?property=schema:name&limit=100&context=${context}`);
    expect(current.status).toBe(200);
    expect((await editor.http(`/v1/subjects/${id}:adopt`, {
      context, property: 'schema:name', mode: 'replace', selection: [{ candidate, rank: 'normal' }],
      expected_head: (current.body.adoption as { head: number } | null)?.head ?? null,
    })).status).toBe(200);
    async function selection() {
      const read = await editor.http(`/v1/subjects/${id}?context=${context}`);
      const candidates = await editor.http(`/v1/subjects/${id}/candidates?property=schema:name&limit=100&context=${context}`);
      expect(read.status).toBe(200);
      expect(candidates.status).toBe(200);
      const chosen = (candidates.body.candidates as (Candidate & { head: number | null })[]).find((c) => c.id === candidate);
      expect(chosen).toBeDefined();
      return { statements: (read.body.subject as Subject).statements['schema:name'], adoption: candidates.body.adoption, accepted: chosen };
    }
    const independentSelectionBefore = await selection();
    expect(independentSelectionBefore.statements).toHaveLength(1);

    const denied = await invoke('denied', feed(changedRows));
    expect(denied.code, denied.stderr).toBe(4);
    expect(revocation).toBeDefined();
    expect(revocation!.held).toBeGreaterThan(0);
    if (!successfulRequest || !successfulExchange) throw new Error('No actual changed envelope committed before revocation');
    const successful = successfulExchange as Exchange;
    expect(successful.keys.length).toBeGreaterThan(0);
    const afterDenial = inspect();
    const completedBaselineAfterDenial = afterDenial.completed;
    expect(completedBaselineAfterDenial).toEqual(completedBaselineBefore);
    expect(afterDenial.active).not.toBeNull();
    expect(afterDenial.pending.length).toBeGreaterThan(0);
    expect(afterDenial.pending.length).toBeLessThan(100);
    const nativeDenials = denied.exchanges.filter((exchange) => exchange.status === 403);
    expect(nativeDenials.length).toBeGreaterThan(0);
    for (const held of heldRequests) {
      const actual = nativeDenials.filter((exchange) => exchange.bytes === held.bytes);
      expect(actual).toHaveLength(1);
      expect(JSON.parse(actual[0]!.response)).not.toHaveProperty('results');
    }
    const pendingBytes = afterDenial.pending.map((pending) => pending.bytes);
    const pendingKeys = afterDenial.pending.map((pending) => pending.keys);
    for (const pending of afterDenial.pending) {
      expect((JSON.parse(pending.bytes) as BatchWriteRequest).commands.map((c) => c.key)).toEqual(pending.keys);
      expect(nativeDenials.some((exchange) => exchange.bytes === pending.bytes)).toBe(true);
    }
    const successfulKeys = [...new Set(exchanges.filter((e) => e.status === 200 && e.keys.length).flatMap((e) => {
      const result = JSON.parse(e.response) as BatchWriteResult;
      return result.results.filter((entry) => 'value' in entry).map((entry) => entry.key);
    }))];
    const originalReceiptRowsBefore = await receipts(successfulKeys);
    const committedEffectsBefore = await nativeEffects(ids[0]!);
    const mediaBefore = [];
    expect(afterDenial.media.length).toBeGreaterThan(0);
    for (const journal of afterDenial.media) {
      const accepted = JSON.parse(journal.accepted) as { media: { id: string } };
      const observed = await runtime.mediaBoundary.observe(accepted.media.id);
      expect(observed.row.state).toBe('available');
      expect(observed.variants.length).toBeGreaterThan(0);
      mediaBefore.push(observed);
    }
    const denial = await runtime.replay(successfulRequest.clone());
    const denialBody = await denial.json();
    const revokedReplay = { status: denial.status, storedSuccess: denialBody.results ?? null, response: denialBody };
    expect(revokedReplay.status).toBe(403);
    expect(revokedReplay.storedSuccess).toBeNull();
    expect(await receipts(successfulKeys)).toEqual(originalReceiptRowsBefore);

    await native.renewManagement();
    await identity.setBulkPermission(true);
    // A genuinely different supplied successor is ignored while the old sealed generation drains.
    const resumed = await invoke('resumed', feed(successorRows));
    expect(resumed.code, resumed.stderr).toBe(0);
    const afterResume = inspect();
    expect(afterResume.active).toBeNull();
    expect(afterResume.claims).toEqual(before.claims);
    expect(afterResume.completed.source.count).toBe(17);
    expect(afterResume.completed.rows.every((row) => row?.converter_revision === converter_revision)).toBe(true);
    expect(afterResume.completed.rows.every((row) => row?.recordRevision === 'unversioned')).toBe(true);
    for (let i = 0; i < 17; i++) expect(afterResume.completed.rows[i]!.digest).not.toBe(before.completed.rows[i]!.digest);
    const drainExchanges = resumed.exchanges.filter((e) => e.path === '/v1/subjects:batchWrite' && e.phase === 'resumed');
    expect(drainExchanges).toHaveLength(afterDenial.pending.length);
    // Compare in the durable keyset order, preserving actual captured body/key values.
    const orderedReplays = drainExchanges.toSorted((a, b) =>
      pendingBytes.indexOf(a.bytes) - pendingBytes.indexOf(b.bytes));
    const replayedBodies = orderedReplays.map((e) => e.bytes);
    const replayedKeys = orderedReplays.map((e) => e.keys);
    expect(replayedBodies).toEqual(pendingBytes);
    expect(replayedKeys).toEqual(pendingKeys);
    const originalReceiptRowsAfter = await receipts(successfulKeys);
    expect(originalReceiptRowsAfter).toEqual(originalReceiptRowsBefore);
    expect(await nativeEffects(ids[0]!)).toEqual(committedEffectsBefore);
    for (const old of before.journals) expect(afterResume.journals.find((row) => row.key === old.key)).toEqual(old);
    expect(afterResume.media).toEqual(afterDenial.media);
    for (const old of mediaBefore) expect(await runtime.mediaBoundary.observe(old.row.id)).toEqual(old);

    // Native candidate IDs must come from actual successful receipts (or the independent editor).
    const acceptedCandidates = new Set<string>([candidate]);
    for (const exchange of exchanges.filter((e) => e.keys.length && e.status === 200)) {
      for (const result of (JSON.parse(exchange.response) as BatchWriteResult).results) {
        const command = commands.get(result.key)!;
        if (command.op === 'propose' && 'value' in result && 'candidate' in result.value) {
          expect(acceptedCandidates.has(result.value.candidate)).toBe(false);
          acceptedCandidates.add(result.value.candidate);
        }
      }
    }
    const effectsAfterResume = await Promise.all(ids.map(nativeEffects));
    const duplicateEffects = effectsAfterResume.flat().filter((effect) =>
      effect.kind === 'candidate' && !acceptedCandidates.has(effect.row.candidate_id as string));
    expect(duplicateEffects).toEqual([]);
    const independentSelectionAfter = await selection();
    expect(independentSelectionAfter).toEqual(independentSelectionBefore);
    const effects = resumed.exchanges.filter((e) => e.keys.length || e.path === '/v1/media:importFromUrl');
    expect(effects.length).toBeGreaterThan(0);
    const pendingLastEffect = Math.max(...effects.map((e) => e.ordinal));
    const successor = await invoke('successor', feed(successorRows));
    expect(successor.code, successor.stderr).toBe(0);
    const successorEffects = successor.exchanges.filter((e) => e.keys.length || e.path === '/v1/media:importFromUrl');
    expect(successorEffects.length).toBeGreaterThan(0);
    const successorFirstEffect = Math.min(...successorEffects.map((e) => e.ordinal));
    expect(successorFirstEffect).toBeGreaterThan(pendingLastEffect);
    const final = inspect();
    expect(final.active).toBeNull();
    expect(final.claims).toEqual(before.claims);
    for (let i = 0; i < 17; i++) expect(final.completed.rows[i]!.digest).not.toBe(afterResume.completed.rows[i]!.digest);
    expect(await selection()).toEqual(independentSelectionBefore);
    expect(await receipts(successfulKeys)).toEqual(originalReceiptRowsBefore);
    for (const old of mediaBefore) expect(await runtime.mediaBoundary.observe(old.row.id)).toEqual(old);
    const worker = await runtime.mediaBoundary.capture();
    expect(worker.executedJobs).toBeGreaterThan(0);
    expect(worker.liveInternetRequests).toEqual([]);
    const evidence = {
      revisions, bundleDigest: bundledDigest,
      inputs: { initial: initial.inputSha256, changed: denied.inputSha256, successor: successor.inputSha256 },
      seals: { initial: initial.seals, denied: denied.seals, resumed: resumed.seals, successor: successor.seals },
      completedBaselineBefore, completedBaselineAfterDenial, pending: afterDenial.pending,
      resumedRows: afterResume.completed.rows, successorRows: final.completed.rows,
      successful, revocation, heldRequests, nativeDenials, revokedReplay, replayedBodies, replayedKeys,
      originalReceiptRowsBefore, originalReceiptRowsAfter, committedEffectsBefore, effectsAfterResume,
      journalsBefore: before.journals, journalsAfter: afterResume.journals, mediaJournals: afterDenial.media,
      media: mediaBefore, independentSelectionBefore, independentSelectionAfter, duplicateEffects,
      pendingLastEffect, successorFirstEffect, exchanges,
      worker: { jobs: worker.executedJobs, calls: worker.calls, registrations: worker.registrations.map((r) => r.name) },
    };
    expect(isDeepStrictEqual(completedBaselineBefore, completedBaselineAfterDenial)).toBe(true);
    const evidenceDirectory = resolve(import.meta.dir, '../../../../.temp/goal/cli-midrun-authority-resume');
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'native-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('CLI mid-run authority native evidence', JSON.stringify(evidence));
    return {
      initial, denied, nativeDenials, completedBaselineBefore, completedBaselineAfterDenial,
      pendingBytes, pendingKeys, revokedReplay, resumed, replayedBodies, replayedKeys,
      originalReceiptRowsBefore, originalReceiptRowsAfter, duplicateEffects, successor,
      pendingLastEffect, successorFirstEffect, independentSelectionBefore, independentSelectionAfter, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
