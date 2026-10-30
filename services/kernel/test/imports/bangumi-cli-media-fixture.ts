import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import sharp from 'sharp';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { MediaImportAccepted } from '@rezics/definitions/media-import';
import { converter_revision } from '../../../../packages/conversion/src/bangumi.ts';
import { runImportCli } from '../../../importer/src/cli.ts';
import { IMPORTER_SCOPES } from '../../../importer/src/credentials.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { CoverSummary } from '../../src/semantic/summaries.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type Candidate = {
  id: string;
  statement: {
    property: { id: string };
    value: { type: string; content: unknown };
    references?: { parts: { property: { id: string }; value: unknown }[] }[];
  };
  source: {
    source: string;
    external_id: string;
    field_group: string;
    converter_revision: string;
    digest: string;
  } | null;
  retracted: number | null;
  head: number | null;
};
type Listing = { candidates: Candidate[]; adoption: { head: number } | null; next: string | null };
type SubjectBody = {
  subject: { id: string; statements: Record<string, { id: string; value: { content: unknown } }[]> };
  summary: { cover: CoverSummary | null };
};
type Exchange = { path: string; method: string; key: string | null; bytes: string; status: number; response: string };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One native world; only external source bytes, HTTP routing and worker scheduling are supplied. */
export async function runBangumiMediaCliJourney() {
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
    directory = await mkdtemp('/dev/shm/bangumi-media-cli-');
    const state = join(directory, 'state.sqlite');
    const keyPath = join(directory, 'account.jwk');
    await writeFile(state, '', { mode: 0o600, flag: 'wx' });
    const native = identitySupport(runtime.identity);
    const editor = await openApiObserver(runtime);
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
    const approved = await runtime.identity.auth.internal.approveCredentialEffect(effect);
    await runtime.identity.auth.internal.applyCredentialEffect({ ...effect, authorization: approved.reference });
    await writeFile(keyPath, JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid, alg: 'ES256' }), {
      mode: 0o600,
      flag: 'wx',
    });
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    const api = 'https://bangumi-cli.import.test';
    const auth = new URL(runtime.identity.auth.verifier.jwksUrl).origin;
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
      runtime.identity.bulk.accountId,
      '--client',
      runtime.identity.client.clientId,
    ];
    const raw = JSON.parse(
      await readFile(new URL('../../../../specs/fixtures/imports/bangumi/subject.json', import.meta.url), 'utf8'),
    );
    const owner = { source: 'bangumi', external_id: String(raw.id) };
    const summarySentinel = 'SUMMARY_END_SENTINEL';
    const urls = [raw.images.large as string, 'https://lain.bgm.tv/pic/cover/l/ab/cd/424242_refreshed.png'];
    const sources: Uint8Array[] = [];
    for (const [index, background] of ['#ff0000', '#0000ff'].entries()) {
      const bytes = new Uint8Array(
        await sharp({ create: { width: 48, height: 32, channels: 3, background } })
          .png()
          .toBuffer(),
      );
      const supplied = await runtime.mediaBoundary.source(urls[index]!, undefined, bytes);
      sources.push(supplied.bytes);
    }
    expect(digest(sources[0]!)).not.toBe(digest(sources[1]!));
    const exchanges: Exchange[] = [];
    const reservations = new Set<string>();
    const drained = new Set<string>();
    const signal = new AbortController().signal;
    function inspect() {
      const session = new ImportSession(state);
      try {
        const claim = session.bindings.claim(owner);
        return {
          claim,
          baseline: session.store.key(owner.source, owner.external_id).baseline,
          source: session.store.source(owner.source),
          bootstraps: session.store.database
            .query(
              'SELECT r.bootstrap_key,j.bytes,j.acknowledgement FROM binding_records r JOIN binding_journal j ON j.source=r.source AND j.external_id=r.external_id AND j.key=r.bootstrap_key WHERE r.source=? AND r.external_id=?',
            )
            .all(owner.source, owner.external_id),
          covers: session.bindings.candidates(owner, 'cover', { limit: 100 }),
        };
      } finally {
        session.close();
      }
    }
    async function invoke(payload: unknown) {
      const input = new TextEncoder().encode(JSON.stringify(payload) + '\n');
      let consumed = 0;
      let sealed = false;
      let observedDigest: unknown;
      const offset = exchanges.length;
      const result = await runImportCli(argv, {
        signal,
        stdin: (async function* () {
          for (let offset = 0; offset < input.length; offset += 127) {
            const chunk = input.slice(offset, offset + 127);
            consumed += chunk.length;
            yield chunk;
          }
        })(),
        observer: {
          onAccountKey(path, observation) {
            expect(path).toBe(keyPath);
            expect(observation.mode & 0o777).toBe(0o600);
          },
          onCoordinator({ importer, registration }) {
            expect(registration.converter_revision).toBe(converter_revision);
            const store = importer.session.store;
            const seal = store.seal.bind(store);
            store.seal = (run, input) => {
              const result = seal(run, input);
              sealed = input.complete && result.status === 'ready';
              // Retain the actual seal result, never an expected source snapshot.
              observedDigest = result;
              return result;
            };
          },
        },
        fetch: (async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          expect(consumed).toBe(new TextEncoder().encode(JSON.stringify(payload) + '\n').length);
          expect(sealed).toBe(true);
          if (url.origin === auth) return native.host.service.handler(request);
          expect(url.origin).toBe(api);
          expect(request.headers.has('cookie')).toBe(false);
          const claims = decodeJwt(request.headers.get('authorization')!.slice(7));
          expect(claims.sub).toBe(runtime.identity.bulk.accountId);
          expect(claims.client_id).toBe(runtime.identity.client.clientId);
          expect(String(claims.scope).split(' ').sort()).toEqual([...IMPORTER_SCOPES].sort());
          const bytes = request.method === 'GET' ? '' : await request.clone().text();
          if (url.pathname === '/v1/subjects:batchWrite') {
            for (const command of (JSON.parse(bytes) as BatchWriteRequest).commands) {
              expect(command.source).toMatchObject({ ...owner, converter_revision, record_revision: 'unversioned' });
              runtime.commands.set(command.key, { command, actor: runtime.identity.bulk.accountId });
            }
          }
          const statusId = /^\/v1\/media\/([^/]+):importStatus$/.exec(url.pathname)?.[1];
          if (statusId && reservations.has(statusId) && !drained.has(statusId)) {
            // A real committed reservation precedes one bounded dispatch of the registered worker.
            await runtime.mediaBoundary.drain({ mediaIds: [statusId], maxJobs: 16, signal });
            drained.add(statusId);
          }
          const response = await runtime.replay(request);
          const responseBytes = await response.clone().text();
          exchanges.push({
            path: url.pathname,
            method: request.method,
            key: request.headers.get('idempotency-key'),
            bytes,
            status: response.status,
            response: responseBytes,
          });
          if (url.pathname === '/v1/media:importFromUrl' && response.status === 202) {
            const accepted = JSON.parse(responseBytes) as MediaImportAccepted;
            expect(accepted.media.state).toBe('reserved');
            reservations.add(accepted.media.id);
          }
          return response;
        }) as typeof fetch,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.openHandles).toBe(0);
      expect(result.stderr).not.toContain('Bearer ');
      expect(result.stderr).not.toContain(kid);
      const captured = exchanges.slice(offset);
      return {
        ...result,
        consumed,
        seal: observedDigest,
        captured,
        writes: captured.filter((e) => e.method !== 'GET'),
      };
    }
    const initial = await invoke(raw);
    const first = inspect();
    if (first.claim?.state !== 'bound') throw new Error('Missing CLI subject binding');
    const subject = first.claim.subject;
    async function bootstrap() {
      const local = inspect().bootstraps;
      expect(local).toHaveLength(1);
      const key = (local[0] as { bootstrap_key: string }).bootstrap_key;
      const rows = await runtime.database.admin.query(
        'SELECT transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
        [
          partitionOf(tupleRoute(runtime.identity.routeKey, owner.source, owner.external_id)),
          'account',
          runtime.identity.bulk.accountId,
          'subject.batch_create',
          key,
        ],
      );
      expect(rows.rows).toHaveLength(1);
      return { local, native: rows.rows };
    }
    async function listing(property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const result = response.body as unknown as Listing;
      expect(result.next).toBeNull();
      return result;
    }
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    async function select(property: string, candidate: Candidate) {
      const before = await listing(property);
      const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${candidate.id}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: candidate.head,
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        expected_head: before.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: 'normal' }],
      });
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    }
    async function current(property: string) {
      const candidates = (await listing(property)).candidates.filter(
        (c) => c.source?.source === owner.source && c.source.external_id === owner.external_id && c.retracted === null,
      );
      expect(candidates.length).toBeGreaterThan(0);
      return candidates[0]!;
    }
    async function publicSubject() {
      const response = await runtime.request(`/v1/subjects/${subject}`);
      expect(response.status).toBe(200);
      return (await response.json()) as SubjectBody;
    }
    const summaryCandidate = await current('schema:abstract');
    await select('schema:abstract', summaryCandidate);
    const reference = summaryCandidate.statement.value.content as { id: string };
    const summaryResponse = await editor.http(`/v1/documents/${reference.id}`);
    expect(summaryResponse.status, JSON.stringify(summaryResponse.body)).toBe(200);
    const rights = await runtime.database.admin.query<{ rights: { license: string } }>(
      'SELECT rights FROM content.imported_field WHERE route=$1 AND id=$2',
      [routeOf(reference.id), reference.id],
    );
    expect(rights.rows).toHaveLength(1);
    const initialSummary = { licence: rights.rows[0]!.rights.license, text: JSON.stringify(summaryResponse.body) };
    expect(initialSummary.text).toContain(summarySentinel);

    // Another contributor's independently proposed/adopted name, using retrieved citations.
    const cited = await current('schema:name');
    const proposed = await editor.http(`/v1/subjects/${subject}/candidates`, {
      statement: {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Community observatory title' } },
        references: cited.statement.references?.map((reference) => ({
          parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
        })),
      },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const independent = (await listing('schema:name')).candidates.find((c) => c.id === proposed.body.candidate)!;
    expect(independent.source).toBeNull();
    await select('schema:name', independent);
    const independentMetadataBefore = (await publicSubject()).subject.statements['schema:name'];
    expect(independentMetadataBefore?.map((s) => s.id)).toContain(independent.id);

    async function selectedCover(version: number) {
      const candidate = await current('schema:image');
      await select('schema:image', candidate);
      const media = candidate.statement.value.content;
      if (typeof media !== 'string') throw new Error('Missing public candidate media reference');
      const observed = await runtime.mediaBoundary.observe(media);
      expect(observed.row).toMatchObject({
        id: media,
        containerId: subject,
        state: 'available',
        sourceUrl: urls[version],
        sha256: digest(sources[version]!),
      });
      expect(observed.row.credit.license).toBe('LicenseRef-unknown');
      expect(observed.row.provenance).toMatchObject({ ...owner, field_group: 'cover', converter_revision });
      expect(observed.transitions).toEqual(['reserved', 'uploaded', 'available']);
      // The boundary calls this original: it is the actual stored upload, not a served variant.
      expect(observed.original).toEqual(sources[version]!);
      const body = await publicSubject();
      expect(body.summary.cover?.media).toBe(media);
      expect(body.summary.cover?.credit).toEqual(observed.row.credit);
      for (const variant of body.summary.cover!.variants) {
        const response = await runtime.request(
          `/v1/media/${media}:authorizeDownload?variant=${variant.format}-${variant.width}`,
        );
        expect(response.status).toBe(200);
        const decision = (await response.json()) as { allowed: boolean; key: string };
        expect(decision.allowed).toBe(true);
        const nativeVariant = observed.variants.find((v) => v.key === decision.key)!;
        expect(nativeVariant).toBeDefined();
        const stored = await runtime.mediaBoundary.configuration.storage.get(decision.key);
        expect(stored).toEqual(nativeVariant.bytes);
        expect(stored).not.toEqual(sources[version]!);
        const { data, info } = await sharp(stored!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const means = [0, 0, 0];
        for (let i = 0; i < data.length; i++) means[i % 3]! += data[i]! / (info.width * info.height);
        expect(means[version === 0 ? 0 : 2]!).toBeGreaterThan(200);
        expect(means[version === 0 ? 2 : 0]!).toBeLessThan(40);
      }
      const original = await runtime.request(`/v1/media/${media}:authorizeDownload?variant=original`);
      expect(original.status).toBe(404);
      return observed;
    }
    const cover = await selectedCover(0);
    const originalBootstrapBefore = await bootstrap();
    const unchanged = await invoke(raw); // Every CLI invocation closes/reopens its own real state handle.
    const unchangedWrites = unchanged.writes;
    expect(unchangedWrites).toEqual([]);
    const changed = structuredClone(raw);
    changed.images.large = urls[1];
    changed.name = 'The Clockwork Observatory refreshed';
    const refreshed = await invoke(changed);
    expect(inspect().claim).toEqual(first.claim);
    const refreshedCover = await selectedCover(1);
    expect(refreshedCover.row.id).not.toBe(cover.row.id);
    expect(refreshedCover.original).not.toEqual(cover.original);
    // Old stored bytes and variants remain immutable through replacement.
    expect(await runtime.mediaBoundary.observe(cover.row.id)).toEqual(cover);

    const fenced = await editor.http('/v1/sourceFences:takedown', {
      source: owner.source,
      externalId: owner.external_id,
      fieldGroup: 'cover',
      reason: 'Cover rights complaint',
    });
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(200);
    const captureBeforeFenceRuns = await runtime.mediaBoundary.capture();
    const unchangedFenced = await invoke(changed);
    expect(unchangedFenced.writes).toEqual([]);
    const fencedInput = structuredClone(changed);
    fencedInput.images.large = 'https://lain.bgm.tv/pic/cover/l/ab/cd/424242_fenced.png';
    fencedInput.name = 'Unfenced facts may still refresh';
    const fencedRefresh = await invoke(fencedInput);
    const fencedReopen = await invoke(fencedInput);
    expect(fencedReopen.writes).toEqual([]);
    for (const invocation of [unchangedFenced, fencedRefresh, fencedReopen]) {
      expect(invocation.captured.filter((e) => e.path === '/v1/media:importFromUrl')).toEqual([]);
      for (const exchange of invocation.writes) {
        const commands = (JSON.parse(exchange.bytes) as BatchWriteRequest).commands;
        expect(commands.filter((c) => c.source.field_group === 'cover')).toEqual([]);
      }
    }
    const capture = await runtime.mediaBoundary.capture();
    const afterFenceSourceRequests = capture.sourceRequests.slice(captureBeforeFenceRuns.sourceRequests.length);
    expect(afterFenceSourceRequests).toEqual([]);
    expect(capture.liveInternetRequests).toEqual([]);
    expect(
      capture.calls
        .filter((c) => reservations.has(c.mediaId))
        .map((c) => c.name)
        .sort(),
    ).toEqual(
      [
        CONTENT_WORKFLOWS.importFromUrl,
        CONTENT_WORKFLOWS.image,
        CONTENT_WORKFLOWS.importFromUrl,
        CONTENT_WORKFLOWS.image,
      ].sort(),
    );
    const disclosed = await publicSubject();
    expect(disclosed.summary.cover).toBeNull();
    const independentMetadataAfter = disclosed.subject.statements['schema:name'];
    expect(independentMetadataAfter).toEqual(independentMetadataBefore);
    for (const image of [cover, refreshedCover]) {
      const variant = image.variants[0]!;
      const denied = await runtime.request(
        `/v1/media/${image.row.id}:authorizeDownload?variant=${variant.format}-${variant.width}`,
      );
      expect(denied.status).toBe(404);
    }
    // A cover complaint does not license or hide the independent summary tuple.
    expect((await editor.http(`/v1/documents/${reference.id}`)).status).toBe(200);
    const summaryFence = await runtime.importTransport.fence(
      { source: owner.source, externalId: owner.external_id, fieldGroup: 'summary' },
      signal,
    );
    expect(summaryFence.fenced).toBe(false);
    const summaryTakedown = await editor.http('/v1/sourceFences:takedown', {
      source: owner.source,
      externalId: owner.external_id,
      fieldGroup: 'summary',
      reason: 'Independent summary complaint',
    });
    expect(summaryTakedown.status).toBe(200);
    expect((await editor.http(`/v1/documents/${reference.id}`)).status).toBe(404);

    const nativeWriteReceipts = [];
    for (const [key, { command }] of runtime.commands) {
      if (command.source.source !== owner.source || command.source.external_id !== owner.external_id) continue;
      const receipt = await runtime.receipt(key);
      expect(receipt).not.toBeNull();
      nativeWriteReceipts.push({ key, receipt });
    }
    const originalBootstrapAfter = await bootstrap();
    expect(originalBootstrapAfter).toEqual(originalBootstrapBefore);
    console.info(
      JSON.stringify({
        journey: 'Bangumi licensed summary and cover CLI lifecycle',
        converter: converter_revision,
        recordRevision: 'unversioned',
        bundle: bundledDigest,
        subject,
        sourceDigests: [...runtime.commands.values()]
          .filter(
            ({ command }) => command.source.source === owner.source && command.source.external_id === owner.external_id,
          )
          .map(({ command }) => command.source.digest),
        media: [cover.row.id, refreshedCover.row.id],
        jobs: capture.calls.filter((c) => reservations.has(c.mediaId)),
        receipts: nativeWriteReceipts,
        originalSha256: [digest(cover.original!), digest(refreshedCover.original!)],
        suppliedSha256: sources.map(digest),
        nativeGrowthEvidence: 'missing; no new growth series measured',
      }),
    );
    return {
      initial,
      unchanged,
      refreshed,
      initialSummary,
      summarySentinel,
      cover,
      sourceBytes: sources[0]!,
      refreshedCover,
      unchangedWrites,
      fencedRefresh,
      fencedReopen,
      afterFenceSourceRequests,
      disclosedCoverAfterFence: disclosed.summary.cover,
      originalBootstrapBefore,
      originalBootstrapAfter,
      independentMetadataBefore,
      independentMetadataAfter,
      nativeWriteReceipts,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
