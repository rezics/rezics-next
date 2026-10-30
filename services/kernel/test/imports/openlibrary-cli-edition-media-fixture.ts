import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest } from '@rezics/definitions/media-import';
import { bundledRelease, bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import type { RecordRow } from '../../../importer/src/record-store.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { Statement } from '../../src/semantic/item.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';
import workSource from '../../../../specs/fixtures/imports/open-library/work.json';
import editionSource from '../../../../specs/fixtures/imports/open-library/edition.json';

type Candidate = { id: string; statement: Statement; revision: number; retracted: number | null };
type Exchange = { source: string; path: string; key: string | null; bytes: string; status: number; body: string };
type Journal = { key: string; bytes: string; acknowledgement: string | null };
const own = 'edition-books';
const foreign = 'independent-books';
const relation = 'schema:exampleOfWork';

/** One CLI-owned SQLite ledger, one native application/Auth/worker world. Only
 * provider image bytes and object storage are external doubles. */
export async function runOpenLibraryEditionMediaJourney() {
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
    directory = await mkdtemp('/dev/shm/openlibrary-edition-cli-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const identity = runtime.identity;
    const support = identitySupport(identity);
    const editor = await openApiObserver(runtime);
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

    // These are honestly synthetic additions to the checked-in bibliographic
    // fixtures, retaining revisions 7/11 and their native 2025 modification dates.
    const work = structuredClone(workSource);
    const edition = {
      ...structuredClone(editionSource),
      languages: [{ key: '/languages/eng' }],
      covers: [900000002, 900000003, -1],
    };
    const unrelatedWork = { ...work, covers: [] };
    const coverUrls = [...work.covers, ...edition.covers]
      .filter((id) => id !== -1)
      .map((id) => `https://covers.openlibrary.org/b/id/${id}-L.jpg`);
    for (const url of coverUrls) await runtime.mediaBoundary.source(url);

    const auth = new URL(identity.auth.verifier.jwksUrl).origin;
    const api = 'https://kernel.import.test';
    const exchanges: Exchange[] = [];
    const publicReads: { path: string; status: number; body: unknown }[] = [];
    const acceptedMedia = new Set<string>();
    const drained = new Set<string>();
    let scheduling = Promise.resolve();
    let sealed = false;
    const coordinators: { source: string; converterModule: string; decoderModule: string }[] = [];

    async function invoke(source: string, records: readonly (typeof work | typeof edition)[]) {
      const dump = join(directory!, `${source}.tsv`);
      const bytes =
        records
          .map((record) =>
            [record.type.key, record.key, record.revision, record.last_modified.value, JSON.stringify(record)].join(
              '\t',
            ),
          )
          .join('\n') + '\n';
      await writeFile(dump, bytes, { mode: 0o600 });
      sealed = false;
      const start = exchanges.length;
      const result = await runImportCli(
        [
          '--source',
          'openlibrary',
          '--source-alias',
          source,
          '--dump',
          dump,
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
        ],
        {
          observer: {
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onCoordinator({ importer, registration, converterModule, decoderModule }) {
              expect(registration.source).toBe(source);
              expect(registration.converter_revision).toBe(converter_revision);
              coordinators.push({ source: registration.source, converterModule, decoderModule });
              // Observation only: require the real acquisition to have sealed before
              // the first effect. No run/record/binding state is changed here.
              const seal = importer.session.store.seal.bind(importer.session.store);
              importer.session.store.seal = (...args) => {
                const outcome = seal(...args);
                sealed = outcome.status === 'ready';
                return outcome;
              };
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === auth) return support.host.service.handler(request);
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            const bytes = await request.clone().text();
            if (request.method !== 'GET') expect(sealed).toBe(true);
            if (url.pathname === '/v1/subjects:batchWrite') {
              for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
                expect(command.source.source).toBe(source);
                // The existing native receipt observer needs only this captured locator.
                runtime.commands.set(command.key, { command, actor: identity.bulk.accountId });
              }
            }
            const statusId = /^\/v1\/media\/([^/]+):importStatus$/.exec(url.pathname)?.[1];
            if (statusId && acceptedMedia.has(statusId) && !drained.has(statusId)) {
              // Schedule the registered worker at an actual reservation anchor;
              // the response below still comes from the unchanged native API.
              scheduling = scheduling.then(async () => {
                if (drained.has(statusId)) return;
                await runtime.mediaBoundary.drain({ mediaIds: [statusId], maxJobs: 16, signal: request.signal });
                drained.add(statusId);
              });
              await scheduling;
            }
            const response = await runtime.replay(request);
            const body = await response.clone().text();
            exchanges.push({
              source,
              path: url.pathname,
              key: request.headers.get('idempotency-key'),
              bytes,
              status: response.status,
              body,
            });
            if (url.pathname === '/v1/media:importFromUrl' && response.status === 202)
              acceptedMedia.add((JSON.parse(body) as MediaImportAccepted).media.id);
            return response;
          }) as typeof fetch,
        },
      );
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.openHandles).toBe(0);
      for (const exchange of exchanges.slice(start)) {
        expect(exchange.status, `${exchange.path}: ${exchange.body}`).toBeLessThan(400);
        if (exchange.path === '/v1/subjects:batchWrite')
          for (const entry of (JSON.parse(exchange.body) as BatchWriteResult).results)
            expect(entry.status, JSON.stringify(entry)).toBeLessThan(400);
      }
      return result;
    }

    function local<T>(read: (db: Database) => T): T {
      const db = new Database(state, { readonly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    }
    function baseline(source: string, key: string) {
      return local((db) => {
        const pointer = db.query('SELECT generation,present_count FROM run_sources WHERE source=?').get(source) as {
          generation: string;
          present_count: number;
        };
        const entry = db
          .query('SELECT row_json,projection_json FROM run_entries WHERE source=? AND run_id=? AND record_key=?')
          .get(source, pointer.generation, key) as { row_json: string; projection_json: string };
        expect(entry).toBeDefined();
        return {
          pointer,
          row: JSON.parse(entry.row_json) as RecordRow,
          projection: JSON.parse(entry.projection_json) as { normalizedRecord: { authors: { key: string }[] } },
        };
      });
    }
    const commands = () =>
      exchanges
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.bytes) as BatchWriteRequest).commands);
    function claim(source: string, key: string) {
      const create = commands().find(
        (c) => c.op === 'create' && c.source.source === source && c.source.external_id === key,
      );
      if (!create) throw new Error('Missing captured bootstrap request');
      const reply = exchanges
        .filter((e) => e.path === '/v1/subjects:batchWrite')
        .flatMap((e) => (JSON.parse(e.body) as BatchWriteResult).results)
        .find((r) => r.key === create.key);
      if (!reply || !('value' in reply) || !('id' in reply.value)) throw new Error('Missing native bootstrap reply');
      const binding = local((db) =>
        db.query('SELECT state,subject FROM binding_records WHERE source=? AND external_id=?').get(source, key),
      );
      expect(binding).toEqual({ state: 'bound', subject: reply.value.id });
      return reply.value.id;
    }
    async function bootstrap() {
      const create = commands().find(
        (c) => c.op === 'create' && c.source.source === own && c.source.external_id === edition.key,
      )!;
      const journal = local(
        (db) =>
          db
            .query('SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
            .get(own, edition.key, create.key) as Journal,
      );
      const receipt = await runtime.receipt(create.key);
      expect(receipt).toBeString();
      expect(journal.acknowledgement).not.toBeNull();
      const locator = JSON.parse(receipt!);
      const persisted = await runtime.database.admin.query(
        'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
        [
          locator.partition_no,
          locator.principal_kind,
          locator.principal_id,
          locator.command_kind,
          locator.idempotency_key,
        ],
      );
      expect(persisted.rows).toHaveLength(1);
      return { journal, receipt, persisted: persisted.rows[0] };
    }
    async function candidates(id: string, property: string, target?: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100', ...(target ? { target } : {}) })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as Candidate[];
    }
    async function select(id: string, property: string, rows: Candidate[], target?: string) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const response = await editor.http(`/v1/subjects/${id}/candidates/${row.id}:accept`, {
          context: GLOBAL_CONTEXT,
          expected_head: null,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      const adopted = await editor.http(`/v1/subjects/${id}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        ...(target ? { target } : {}),
        mode: 'replace',
        selection: rows.map((row) => ({ candidate: row.id, rank: 'normal' })),
        expected_head: null,
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }
    async function subject(id: string) {
      const path = `/v1/subjects/${id}`;
      const response = await runtime.request(path);
      const body = (await response.json()) as { subject: Subject };
      publicReads.push({ path, status: response.status, body });
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body.subject;
    }

    await invoke(foreign, [unrelatedWork]);
    const foreignWorkId = claim(foreign, work.key);
    const foreignBaseline = baseline(foreign, work.key);
    const initial = await invoke(own, [edition]);
    const editionId = claim(own, edition.key);
    const originalBootstrapBefore = await bootstrap();
    const initialBaseline = baseline(own, edition.key);
    const unresolved = await candidates(editionId, relation);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.statement.value).toEqual({ type: 'somevalue' });
    const author = await candidates(editionId, 'schema:author');
    expect(author).toHaveLength(1);
    expect(author[0]!.statement.value).toEqual({ type: 'somevalue' });
    // Capture the full source citation from the persisted normalized row, and
    // independently check its native unresolved identifier qualifier.
    const unresolvedAuthorCitation = initialBaseline.projection.normalizedRecord.authors[0]!.key;
    expect(author[0]!.statement.qualifiers).toContainEqual({
      property: { id: 'wdt:P648', data_type: 'external-id' },
      value: { type: 'value', content: unresolvedAuthorCitation.split('/').at(-1)! },
    });
    const workImport = await invoke(own, [edition, work]);
    const workId = claim(own, work.key);
    const learnedRefresh = await invoke(own, [edition, work]);
    const learnedBaseline = baseline(own, edition.key);
    expect(learnedBaseline.row).toEqual(initialBaseline.row);
    expect(baseline(foreign, work.key)).toEqual(foreignBaseline);
    const resolved = await candidates(editionId, relation, workId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.statement.value).toEqual({ type: 'value', content: workId });
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await select(editionId, relation, resolved, workId);
    for (const property of ['schema:author', 'schema:isbn', 'schema:inLanguage', 'schema:image'])
      await select(editionId, property, await candidates(editionId, property));
    const links = linkProjection(runtime.database.pool);
    let caughtUp = false;
    for (let batch = 0; batch < 16; batch++) {
      const delivery = await links.run(partitionOf(routeOf(editionId)!));
      expect(delivery.status).not.toBe('stopped');
      if (delivery.status === 'read' && delivery.envelopes === 0) {
        caughtUp = true;
        break;
      }
      if (delivery.status === 'busy') await Bun.sleep(5);
    }
    expect(caughtUp).toBe(true);
    const selected = await subject(editionId);
    const resolvedWorkRelation = selected.statements[relation]![0]!.value.content;
    const isbnValues = selected.statements['schema:isbn']!.map((s) => s.value.content);
    const languageValues = selected.statements['schema:inLanguage']!.map((s) => s.value.content);
    expect(isbnValues).toEqual(['9780306406157']);
    expect(languageValues).toEqual(['en']);
    const selectedMedia = selected.statements['schema:image']!.map((s) => String(s.value.content));
    expect(selectedMedia).toHaveLength(2);
    const availableCovers = await Promise.all([...acceptedMedia].map((id) => runtime.mediaBoundary.observe(id)));
    expect(availableCovers).toHaveLength(3);
    for (const media of availableCovers) {
      expect(media.row.credit.license).toBe('LicenseRef-unknown');
      expect(media.row.credit.via?.name).toBe('Open Library');
      expect(media.row.provenance.converter_revision).toBe(converter_revision);
      expect(media.row.provenance.source).toBe(own);
      expect(media.transitions).toContain('available');
      expect(coverUrls).toContain(media.row.sourceUrl);
    }
    const downloads = availableCovers
      .filter((media) => selectedMedia.includes(media.row.id))
      .map((media) => {
        const variant = media.variants[0]!;
        return {
          media,
          variant,
          path: `/v1/media/${media.row.id}:authorizeDownload?variant=${variant.format}-${variant.width}`,
        };
      });
    for (const download of downloads) {
      const response = await editor.http(download.path);
      publicReads.push({ path: download.path, ...response });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.allowed).toBe(true);
      expect(response.body.key).toBe(download.variant.key);
      const bytes = await runtime.mediaBoundary.configuration.storage.get(download.variant.key);
      expect(bytes).toEqual(download.variant.bytes);
    }
    const mediaBeforeFence = local((db) =>
      db
        .query('SELECT key,bytes FROM binding_media WHERE source=? AND external_id=? ORDER BY key')
        .all(own, edition.key),
    );
    const beforeTrace = await runtime.mediaBoundary.capture();
    expect(beforeTrace.liveInternetRequests).toEqual([]);
    expect(beforeTrace.calls.some((call) => call.name === CONTENT_WORKFLOWS.importFromUrl)).toBe(true);
    const nativeEntryRevisionBefore = (await subject(editionId)).revision;
    for (const id of selectedMedia) {
      const taken = await editor.http(`/v1/media/${id}:takeDown`, { reason: 'Cover rights complaint' });
      expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    }
    const fenced = await editor.http('/v1/sourceFences:takedown', {
      source: own,
      externalId: edition.key,
      fieldGroup: 'cover',
      reason: 'Cover rights complaint',
    });
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(200);
    const fencedReopen = await invoke(own, [edition, work]);
    const afterFence = await subject(editionId);
    for (const download of downloads) {
      const response = await editor.http(download.path);
      publicReads.push({ path: download.path, ...response });
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body).not.toHaveProperty('key');
    }
    const disclosedCoversAfterFence = afterFence.statements['schema:image'] ?? [];
    const nativeEntryRevisionAfter = afterFence.revision;
    const originalBootstrapAfter = await bootstrap();
    expect(baseline(own, edition.key).row).toEqual(initialBaseline.row);
    expect(
      local((db) =>
        db
          .query('SELECT key,bytes FROM binding_media WHERE source=? AND external_id=? ORDER BY key')
          .all(own, edition.key),
      ),
    ).toEqual(mediaBeforeFence);
    const afterTrace = await runtime.mediaBoundary.capture();
    expect(afterTrace.calls).toEqual(beforeTrace.calls);
    expect(afterTrace.sourceRequests).toEqual(beforeTrace.sourceRequests);
    const unavailableSentinelRequests = [
      ...exchanges
        .filter((e) => e.path === '/v1/media:importFromUrl')
        .map((e) => (JSON.parse(e.bytes) as MediaImportRequest).sourceUrl),
      ...afterTrace.sourceRequests.map((request) => request.url),
      ...afterTrace.liveInternetRequests,
    ].filter((url) => /\/b\/id\/-1-L\.jpg/u.test(url));
    const forbidden = [
      work.description.value,
      edition.notes.value,
      'PRIVATE_TEXT_SENTINEL',
      'USER_POST_SENTINEL',
      'ACCOUNT_SENTINEL',
    ];
    const disclosed = JSON.stringify({
      commands: commands(),
      publicReads,
      media: exchanges.filter((e) => e.path === '/v1/media:importFromUrl').map((e) => JSON.parse(e.bytes)),
    });
    const unknownProseOccurrences = forbidden.filter((text) => disclosed.includes(text));
    const receipts = [];
    for (const command of new Map(commands().map((c) => [c.key, c])).values()) {
      const receipt = await runtime.receipt(command.key);
      expect(receipt).toBeString();
      receipts.push({ key: command.key, receipt });
    }
    // Bounded evidence in the managed raw log; credentials never enter it.
    console.info(
      'Open Library CLI native evidence',
      JSON.stringify({
        coordinators,
        bundle: { catalogue: bundledRelease.catalogue, digest: bundledDigest, disclosed: selected.release },
        initialBaseline,
        learnedBaseline,
        editionId,
        workId,
        foreignWorkId,
        receipts,
        bootstrap: originalBootstrapAfter,
        media: availableCovers.map((m) => ({
          row: m.row,
          events: m.events,
          variants: m.variants.map((v) => ({ key: v.key, sha256: v.sha256, byteCount: v.byteCount })),
        })),
        workerCalls: afterTrace.calls,
        publicReads,
      }),
    );
    return {
      initial,
      workImport,
      learnedRefresh,
      fencedReopen,
      editionId,
      workId,
      foreignWorkId,
      editionType: selected.type,
      resolvedWorkRelation,
      unresolvedAuthorCitation,
      isbnValues,
      languageValues,
      unknownProseOccurrences,
      availableCovers,
      unavailableSentinelRequests,
      disclosedCoversAfterFence,
      nativeEntryRevisionBefore,
      nativeEntryRevisionAfter,
      originalBootstrapBefore,
      originalBootstrapAfter,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
