import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportStatus } from '@rezics/definitions/media-import';
import { converter_revision as bangumiRevision } from '../../../../packages/conversion/src/bangumi.ts';
import { converter_revision as libraryRevision } from '../../../../packages/conversion/src/open-library.ts';
import edition from '../../../../specs/fixtures/imports/open-library/edition.json';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { createImporter, Importer } from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { RecordBindings } from '../../../importer/src/record-bindings.ts';
import { RunStore, type Seal } from '../../../importer/src/run-store.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';
import { identitySupport } from './identity-fixture.ts';
import type { NativeMediaObservation } from './media-boundary.ts';

type Journal = { key: string; bytes: string; acknowledgement: string | null };
type MediaJournal = { key: string; bytes: string; accepted: string; status: string };
type Candidate = {
  id: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  retracted: number | null;
};
type Exchange = { path: string; method: string; key: string | null; bytes: string; status: number; response: string };
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function mediaValue(statement: BatchStatement): string {
  if (statement.value.type !== 'value' || typeof statement.value.content !== 'string')
    throw new Error('Missing actual media UUID in selected statement');
  return statement.value.content;
}
const bangumi = { id: 424243, type: 2, name: 'The Rejected Observatory' };
const bangumiUrls = ['https://lain.bgm.tv/rejected-cover.png', 'https://lain.bgm.tv/successor-cover.png'];
const libraryCovers = [900000010, 900000011];
const feeds = [
  {
    source: 'bangumi' as const,
    externalId: String(bangumi.id),
    converter: bangumiRevision,
    provider: 'Bangumi',
    recordUrl: `https://bgm.tv/subject/${bangumi.id}`,
    urls: bangumiUrls,
    input: (successor: boolean) =>
      JSON.stringify({ ...bangumi, images: { large: bangumiUrls[successor ? 1 : 0] } }) + '\n',
  },
  {
    source: 'openlibrary' as const,
    externalId: edition.key,
    converter: libraryRevision,
    provider: 'Open Library',
    recordUrl: `https://openlibrary.org${edition.key}`,
    urls: libraryCovers.map((id) => `https://covers.openlibrary.org/b/id/${id}-L.jpg`),
    input: (successor: boolean) => {
      const record = { ...edition, revision: successor ? 12 : 11, covers: [libraryCovers[successor ? 1 : 0]] };
      return (
        [record.type.key, record.key, record.revision, record.last_modified.value, JSON.stringify(record)].join('\t') +
        '\n'
      );
    },
  },
];
type Feed = (typeof feeds)[number];

/** One application/Auth/worker world. Supply external bytes and schedule registered
 * jobs; every API result, terminal status and receipt comes from native code. */
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
    directory = await mkdtemp('/dev/shm/import-cli-rejected-cover-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    const native = identitySupport(runtime.identity);
    await native.renewManagement();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
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
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const api = 'https://cli-rejected-cover.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
    const exchanges: Exchange[] = [];
    const publicReads: { path: string; status: number; body: unknown }[] = [];
    const accepted = new Set<string>();
    const drained = new Set<string>();

    function inspect(feed: Feed) {
      const session = new ImportSession(state);
      try {
        return {
          source: session.store.source(feed.source),
          active: session.store.activeRun(feed.source),
          record: session.store.key(feed.source, feed.externalId),
          claim: session.bindings.claim({ source: feed.source, external_id: feed.externalId }),
          journals: session.store.database
            .query<Journal, [string, string]>(
              'SELECT key,bytes,acknowledgement FROM binding_journal WHERE source=? AND external_id=? ORDER BY key LIMIT 100',
            )
            .all(feed.source, feed.externalId),
          media: session.store.database
            .query<MediaJournal, [string, string]>(
              'SELECT key,bytes,accepted,status FROM binding_media WHERE source=? AND external_id=? ORDER BY key LIMIT 64',
            )
            .all(feed.source, feed.externalId),
        };
      } finally {
        session.close();
      }
    }

    async function invoke(feed: Feed, successor = false) {
      const start = exchanges.length;
      let ended = false;
      let sealed = false;
      const seals: Seal[] = [];
      const conversions: (readonly BatchCommand[])[] = [];
      const authPaths: { path: string; status: number }[] = [];
      const result = await runImportCli(
        [
          '--source',
          feed.source,
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
          stdin: (async function* () {
            const bytes = new TextEncoder().encode(feed.input(successor));
            for (let offset = 0; offset < bytes.length; offset += 127) yield bytes.slice(offset, offset + 127);
            ended = true;
          })(),
          createImporter(options) {
            // Preserve the options object: CLI wires its real resolver after construction.
            options.onConversionOutput = (output) => conversions.push(structuredClone(output.proposals));
            return createImporter(options);
          },
          observer: {
            onAccountKey(path, observation) {
              expect(path).toBe(keyPath);
              expect(observation.regularFile).toBe(true);
              expect(observation.mode & 0o777).toBe(0o600);
            },
            onCoordinator({ importer, registration, converterModule }) {
              expect(importer).toBeInstanceOf(Importer);
              expect(importer.session).toBeInstanceOf(ImportSession);
              expect(importer.session.store).toBeInstanceOf(RunStore);
              expect(importer.session.bindings).toBeInstanceOf(RecordBindings);
              expect(registration.source).toBe(feed.source);
              expect(registration.converter_revision).toBe(feed.converter);
              expect(converterModule).toBe(
                import.meta.resolve(
                  `../../../../packages/conversion/src/${feed.source === 'bangumi' ? 'bangumi' : 'open-library'}.ts`,
                ),
              );
              const seal = importer.session.store.seal.bind(importer.session.store);
              importer.session.store.seal = (run, input) => {
                const result = seal(run, input);
                seals.push(result);
                sealed = result.status === 'ready';
                return result;
              };
            },
          },
          fetch: (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            const url = new URL(request.url);
            expect(ended).toBe(true);
            expect(sealed).toBe(true);
            if (url.origin === auth) {
              const response = await native.host.service.handler(request);
              authPaths.push({ path: url.pathname, status: response.status });
              return response;
            }
            expect(url.origin).toBe(api);
            expect(request.headers.has('cookie')).toBe(false);
            // Credentials are inspected in memory and never included in diagnostics.
            const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
            expect(claims.sub).toBe(runtime.identity.bulk.accountId);
            expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
            const bytes = request.method === 'GET' ? '' : await request.clone().text();
            if (url.pathname === '/v1/subjects:batchWrite') {
              for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
                expect(command.source.source).toBe(feed.source);
                runtime.commands.set(command.key, { command, actor: runtime.identity.bulk.accountId });
              }
            }
            const id = /^\/v1\/media\/([^/]+):importStatus$/.exec(url.pathname)?.[1];
            if (id && accepted.has(id) && !drained.has(id)) {
              await runtime.mediaBoundary.drain({ mediaIds: [id], maxJobs: 16, signal: request.signal });
              drained.add(id);
            }
            const response = await runtime.replay(request);
            const body = await response.clone().text();
            exchanges.push({
              path: url.pathname,
              method: request.method,
              key: request.headers.get('idempotency-key'),
              bytes,
              status: response.status,
              response: body,
            });
            if (url.pathname === '/v1/media:importFromUrl' && response.status === 202)
              accepted.add((JSON.parse(body) as MediaImportAccepted).media.id);
            return response;
          }) as typeof fetch,
        },
      );
      const captured = exchanges.slice(start);
      console.info(
        'cli-rejected-cover invocation',
        JSON.stringify({ source: feed.source, inputSha256: sha256(feed.input(successor)), result, seals, captured }),
      );
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(seals).toHaveLength(1);
      expect(seals[0]!.status).toBe('ready');
      for (const exchange of captured) {
        expect(exchange.status, exchange.response).toBeLessThan(300);
        if (exchange.path === '/v1/subjects:batchWrite')
          for (const entry of (JSON.parse(exchange.response) as BatchWriteResult).results)
            expect('value' in entry, JSON.stringify(entry)).toBe(true);
      }
      return { ...result, captured, conversions, seals, authPaths, inputSha256: sha256(feed.input(successor)) };
    }

    async function receipts(journals: Journal[]) {
      const rows = [];
      for (const journal of journals) {
        const locator = await runtime.receipt(journal.key);
        expect(locator).toBeString();
        const key = JSON.parse(locator!);
        const native = await runtime.database.admin.query(
          'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
          [key.partition_no, key.principal_kind, key.principal_id, key.command_kind, key.idempotency_key],
        );
        expect(native.rows).toHaveLength(1);
        rows.push({ key: journal.key, locator, rows: native.rows });
      }
      return rows;
    }
    async function candidates(id: string, property: string) {
      const response = await editor.http(
        `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.next).toBeNull();
      return response.body.candidates as unknown as Candidate[];
    }
    async function select(id: string, property: string, candidate: string) {
      expect(
        (
          await editor.http(`/v1/subjects/${id}/candidates/${candidate}:accept`, {
            context: GLOBAL_CONTEXT,
            expected_head: null,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await editor.http(`/v1/subjects/${id}:adopt`, {
            context: GLOBAL_CONTEXT,
            property,
            mode: 'replace',
            expected_head: null,
            selection: [{ candidate, rank: 'normal' }],
          })
        ).status,
      ).toBe(200);
    }
    async function publicRead(path: string) {
      const response = await runtime.request(path);
      const body = await response.json();
      const observed = { path, status: response.status, body };
      publicReads.push(observed);
      return observed;
    }
    async function subject(id: string) {
      const response = await publicRead(`/v1/subjects/${id}`);
      expect(response.status).toBe(200);
      return response.body as { subject: { id: string; statements: Record<string, BatchStatement[]> } };
    }

    const sources = [];
    for (const feed of feeds) {
      await runtime.mediaBoundary.source(feed.urls[0]!, 'corrupt-image');
      const first = await invoke(feed);
      const original = inspect(feed);
      expect(original.active).toBeNull();
      expect(original.source.count).toBe(1);
      if (original.claim?.state !== 'bound') throw new Error('Missing ordinary CLI subject binding');
      const id = original.claim.subject;
      expect(original.record.baseline!.converter_revision).toBe(feed.converter);
      expect(original.record.baseline!.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(original.media).toHaveLength(1);
      const journal = original.media[0]!;
      const rejectedId = (JSON.parse(journal.accepted) as MediaImportAccepted).media.id;
      expect((JSON.parse(journal.status) as MediaImportStatus).media.state).toBe('rejected');
      const rejected = await runtime.mediaBoundary.observe(rejectedId);
      expect(rejected.row.state).toBe('rejected');
      expect(rejected.transitions).toContain('rejected');
      expect(rejected.original).toBeNull();
      const rejectedMappedMediaIds = first.conversions
        .flat()
        .flatMap((command) =>
          command.op === 'propose' && command.source.field_group === 'cover' ? [mediaValue(command.statement)] : [],
        );
      expect(first.conversions.length).toBeGreaterThan(0);
      expect(rejectedMappedMediaIds).toEqual([]);
      expect(await candidates(id, 'schema:image')).toEqual([]);
      const rejectedAttachments = (await subject(id)).subject.statements['schema:image'] ?? [];
      const rejectedDownload = await publicRead(`/v1/media/${rejectedId}:authorizeDownload?variant=webp-48`);
      expect(rejectedDownload.status).toBe(404);
      expect(rejectedDownload.body).not.toHaveProperty('key');
      const importedNames = await candidates(id, 'schema:name');
      expect(importedNames.length).toBeGreaterThan(0);
      for (const candidate of importedNames)
        expect(candidate.source).toMatchObject({
          source: feed.source,
          external_id: feed.externalId,
          digest: original.record.baseline!.digest,
          converter_revision: feed.converter,
        });
      // A separate ordinary contributor's selection must survive importer refresh.
      const independent = await editor.http(`/v1/subjects/${id}/candidates`, {
        statement: {
          property: { id: 'schema:name' },
          value: { type: 'value', content: { language: 'en', text: `Independent ${feed.provider} title` } },
          references: importedNames[0]!.statement.references.map((reference) => ({
            parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
          })),
        },
      });
      expect(independent.status).toBe(201);
      await select(id, 'schema:name', independent.body.candidate as string);
      const independentSelectionBefore = (await subject(id)).subject.statements['schema:name'];
      expect(independentSelectionBefore).toHaveLength(1);
      const originalReceiptsBefore = await receipts(original.journals);
      expect(
        original.journals.filter((entry) =>
          (JSON.parse(entry.bytes) as BatchWriteRequest).commands.some((command) => command.op === 'create'),
        ),
      ).toHaveLength(1);

      // Valid bytes at the old URL cannot reset a terminal native object or its durable journal.
      await runtime.mediaBoundary.source(feed.urls[0]!);
      const beforeReopen = await runtime.mediaBoundary.capture();
      const reopened = await invoke(feed);
      const afterReopen = await runtime.mediaBoundary.capture();
      const reopenMediaPosts = reopened.captured.filter((exchange) => exchange.path === '/v1/media:importFromUrl');
      const reopenSourceRequests = afterReopen.sourceRequests.slice(beforeReopen.sourceRequests.length);
      expect(afterReopen.calls).toEqual(beforeReopen.calls);
      expect(await runtime.mediaBoundary.observe(rejectedId)).toEqual(rejected);
      expect(inspect(feed).media).toEqual(original.media);
      const reopenedStatus = await runtime.importTransport.mediaStatus(rejectedId, new AbortController().signal);
      expect(reopenedStatus.status).toBe(200);
      expect((reopenedStatus.body as MediaImportStatus).media.state).toBe('rejected');

      const successorSource = await runtime.mediaBoundary.source(feed.urls[1]!);
      const successor = await invoke(feed, true);
      const changed = inspect(feed);
      expect(changed.claim).toEqual(original.claim);
      expect(changed.media).toHaveLength(2);
      expect(changed.record.baseline!.digest).not.toBe(original.record.baseline!.digest);
      expect(changed.record.baseline!.converter_revision).toBe(feed.converter);
      const newJournal = changed.media.find((entry) => entry.key !== journal.key)!;
      const availableId = (JSON.parse(newJournal.accepted) as MediaImportAccepted).media.id;
      const available = await runtime.mediaBoundary.observe(availableId);
      expect(available.row.state).toBe('available');
      expect(available.row.sourceUrl).toBe(feed.urls[1]!);
      expect(available.row.credit).toEqual({
        rightsHolder: '(c) rights holder',
        via: { name: feed.provider, url: feed.recordUrl },
        license: 'LicenseRef-unknown',
        obligations: [],
      });
      expect(available.row.provenance).toMatchObject({
        source: feed.source,
        external_id: feed.externalId,
        converter_revision: feed.converter,
        digest: changed.record.baseline!.digest,
        field_group: 'cover',
      });
      expect(available.original).toEqual(successorSource.bytes);
      const coverCandidates = await candidates(id, 'schema:image');
      expect(coverCandidates).toHaveLength(1);
      expect(mediaValue(coverCandidates[0]!.statement)).toBe(availableId);
      expect(coverCandidates[0]!.source!.source).toBe(feed.source);
      await select(id, 'schema:image', coverCandidates[0]!.id);
      const selected = await subject(id);
      expect(selected.subject.statements['schema:image']!.map(mediaValue)).toEqual([availableId]);
      expect(JSON.stringify(selected.subject.statements['schema:image'])).toContain(feed.recordUrl);
      for (const variant of available.variants) {
        const download = await publicRead(
          `/v1/media/${availableId}:authorizeDownload?variant=${variant.format}-${variant.width}`,
        );
        expect(download.status).toBe(200);
        expect(download.body).toMatchObject({ allowed: true, key: variant.key });
      }
      const originalDownload = await publicRead(`/v1/media/${availableId}:authorizeDownload?variant=original`);
      expect(originalDownload.status).toBe(404);
      expect(originalDownload.body).not.toHaveProperty('key');
      expect(await runtime.mediaBoundary.observe(rejectedId)).toEqual(rejected);
      expect(changed.journals.filter((entry) => original.journals.some((old) => old.key === entry.key))).toEqual(
        original.journals,
      );
      expect(changed.media.find((entry) => entry.key === journal.key)).toEqual(journal);
      const originalReceiptsAfter = await receipts(original.journals);
      const independentSelectionAfter = selected.subject.statements['schema:name'];
      sources.push({
        source: feed.source,
        subject: id,
        first,
        rejected,
        rejectedMappedMediaIds,
        rejectedAttachments,
        rejectedDownload,
        reopened,
        reopenedStatus,
        reopenMediaPosts,
        reopenSourceRequests,
        successor,
        available,
        successorSourceBytes: successorSource.bytes,
        originalReceiptsBefore,
        originalReceiptsAfter,
        independentSelectionBefore,
        independentSelectionAfter,
        original,
        changed,
      });
    }
    expect(sources[0]!.subject).not.toBe(sources[1]!.subject);
    // Recheck both children after the other source's complete journey too.
    for (const [index, child] of sources.entries()) {
      expect(inspect(feeds[index]!)).toEqual(child.changed);
      expect(await receipts(child.original.journals)).toEqual(child.originalReceiptsBefore);
      expect(await runtime.mediaBoundary.observe(child.rejected.row.id)).toEqual(child.rejected);
      expect((await subject(child.subject)).subject.statements['schema:name']).toEqual(
        child.independentSelectionBefore,
      );
    }
    const worker = await runtime.mediaBoundary.capture();
    expect(worker.liveInternetRequests).toEqual([]);
    expect(worker.registrations.map((entry) => entry.name)).toContain(CONTENT_WORKFLOWS.importFromUrl);
    expect(worker.registrations.map((entry) => entry.name)).toContain(CONTENT_WORKFLOWS.image);
    const mediaEvidence = (media: NativeMediaObservation) => ({
      ...media,
      original: media.original && sha256(media.original),
      variants: media.variants.map((variant) => ({ ...variant, bytes: sha256(variant.bytes) })),
    });
    const evidence = {
      callerSha256: sha256(new Uint8Array(await Bun.file(import.meta.filename).arrayBuffer())),
      bundleRevision: bundledDigest,
      sources: sources.map((source) => ({
        ...source,
        rejected: mediaEvidence(source.rejected),
        available: mediaEvidence(source.available),
        successorSourceBytes: sha256(source.successorSourceBytes),
      })),
      publicReads,
      worker: {
        executedJobs: worker.executedJobs,
        calls: worker.calls,
        sourceRequests: worker.sourceRequests.map(({ url, bytes }) => ({ url, bytes })),
        registrations: worker.registrations.map(({ name, queue }) => ({ name, queue })),
      },
      nativeGrowth: 'missing: this connected outcome adds no PG growth series',
    };
    const evidencePath = join(
      import.meta.dir,
      '../../../../.temp/goal/cli-rejected-cover-recovery',
      `${randomUUID()}.json`,
    );
    await mkdir(join(evidencePath, '..'), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(`cli-rejected-cover-recovery-evidence ${JSON.stringify(evidence)}`);
    console.info(
      JSON.stringify({
        outcome:
          'ordinary Bangumi and Open Library CLI retain explicit native cover rejection and recover through a valid successor',
        evidencePath,
        children: sources.map((source) => ({
          source: source.source,
          before: source.original.record.baseline,
          after: source.changed.record.baseline,
        })),
        bundleRevision: bundledDigest,
        executedJobs: worker.executedJobs,
      }),
    );
    return { sources, close };
  } catch (error) {
    await close();
    throw error;
  }
}
