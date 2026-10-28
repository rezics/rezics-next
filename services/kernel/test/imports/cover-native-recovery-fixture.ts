import { expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportStatus } from '@rezics/definitions/media-import';
import type { Statement } from '../../../../specs/semantic-driver.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { ImportSession } from '../../../importer/src/import-session.ts';
import { RunStore } from '../../../importer/src/run-store.ts';
import { createMediaResolver } from '../../../importer/src/media-resolver.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

export const isCover = (command: BatchCommand) => command.op !== 'create' && command.source.field_group === 'cover';
type Candidate = { id: string; statement: Statement; retracted: number | null };
type Listing = { candidates: Candidate[]; adoption: { head: number } | null; next: string | null };
type Ack = { command: BatchCommand; result: BatchWriteResult['results'][number]; receipt: string };

/** Native authority stays in the runtime; only scheduling and local crash timing belong here. */
export async function openCoverRecovery() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  let directory: string | undefined;
  let importer: Importer | undefined;
  const original = RunStore.prototype.resolveDeferredCover;
  let armed = false;
  let faultCount = 0;
  let interrupted: Ack | undefined;
  let controller = new AbortController();
  const acknowledgements: Ack[] = [];
  const pending: string[] = [];
  const resolved: string[] = [];
  const close = async () => {
    RunStore.prototype.resolveDeferredCover = original;
    try {
      await importer?.close();
    } finally {
      try {
        await runtime.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const editor = await openApiObserver(runtime);
    directory = await mkdtemp(join(tmpdir(), 'native-cover-recovery-'));
    const path = join(directory, 'state.sqlite');
    const raw = JSON.parse(
      await readFile(new URL('../../../../specs/fixtures/imports/bangumi/subject.json', import.meta.url), 'utf8'),
    );
    const registration = createSourceRegistration('bangumi');
    const owner = { source: registration.source, external_id: String(raw.id) };
    const urls = [
      raw.images.large as string,
      'https://lain.bgm.tv/pic/cover/l/ab/cd/replacement.jpg',
      'https://lain.bgm.tv/pic/cover/l/ab/cd/subsequent.jpg',
    ];
    for (const url of urls) await runtime.mediaBoundary.source(url);
    const transport = runtime.importTransport;
    function open() {
      const next: Importer = new Importer({
        path,
        transport: {
          readFence: (tuple) =>
            transport.fence(
              { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
              controller.signal,
            ),
          async batchWrite(request) {
            // This is the runtime observer's locator cache, not a receipt or effect producer.
            for (const command of request.commands)
              runtime.commands.set(command.key, { command, actor: runtime.identity.bulk.accountId });
            return transport.batch(request, controller.signal);
          },
        },
        async afterBulkSuccess(request, result) {
          for (const command of request.commands) {
            const ack = result.results.find((entry) => entry.key === command.key);
            if (!ack || !('value' in ack)) continue;
            const receipt = await runtime.receipt(command.key);
            expect(receipt).not.toBeNull();
            acknowledgements.push({
              command: structuredClone(command),
              result: structuredClone(ack),
              receipt: receipt!,
            });
          }
        },
        mediaResolver: {
          async resolve(input) {
            const resolver = createMediaResolver({
              bindings: next.session.bindings,
              sleep: (ms) => Bun.sleep(ms),
              port: {
                readFence: (tuple, signal) => transport.fence(tuple, signal),
                async importFromUrl(bytes, key, signal) {
                  const response = await transport.requestMedia(bytes, key, signal);
                  if (response.status === 202) {
                    const id = (response.body as { media: { id: string } }).media.id;
                    const status = await transport.mediaStatus(id, signal);
                    expect(status.status).toBe(200);
                    expect((status.body as MediaImportStatus).media.state).toBe('reserved');
                    pending.push(id);
                  }
                  return response;
                },
                async importStatus(id, signal) {
                  // One bounded delivery of the real registered jobs, after the initial pending pass.
                  await runtime.mediaBoundary.drain({ mediaIds: [id], maxJobs: 16, signal });
                  const status = await transport.mediaStatus(id, signal);
                  if (status.status === 200 && (status.body as MediaImportStatus).media.state === 'available')
                    resolved.push(id);
                  return status;
                },
              },
            });
            const result = await resolver.resolve({
              owner: input.owner,
              containerId: input.subject,
              mediaImportIntents: input.mediaImportIntents,
              signal: input.signal,
              deferPending: input.deferPending ?? false,
            });
            if (result.outcome !== 'resolved' || result.assets.some((asset) => asset.outcome !== 'available'))
              return { status: 'pending' };
            return { status: 'available', mediaIds: result.mediaIds };
          },
        },
      });
      expect(next.session).toBeInstanceOf(ImportSession);
      return next;
    }
    importer = open();
    RunStore.prototype.resolveDeferredCover = function (...args) {
      if (this === importer!.session.store && armed) {
        const bound = importer!.session.bindings.candidates(owner, 'cover', { limit: 100 });
        expect(bound).toHaveLength(1);
        const current = bound[0]!;
        const ack = acknowledgements.findLast((entry) => entry.command.key === current.key);
        expect(ack).toBeDefined();
        const journal = this.database
          .query('SELECT acknowledgement FROM binding_journal WHERE source=? AND external_id=? AND key=?')
          .get(owner.source, owner.external_id, current.key) as { acknowledgement: string | null } | null;
        expect(JSON.parse(journal!.acknowledgement!)).toEqual({ results: [ack!.result] });
        interrupted = structuredClone(ack!);
        armed = false;
        faultCount++;
        controller.abort(new Error('Native cover ACK persisted; local completion interrupted'));
        throw controller.signal.reason;
      }
      return original.apply(this, args);
    };
    const subject = () => {
      const claim = importer!.session.bindings.claim(owner);
      if (claim?.state !== 'bound') throw new Error('Missing native subject binding');
      return claim.subject;
    };
    const covers = () => importer!.session.bindings.candidates(owner, 'cover', { limit: 100 });
    async function listing(property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject()}/candidates?${new URLSearchParams({ property, context: GLOBAL_CONTEXT, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      const body = response.body as unknown as Listing;
      expect(body.next).toBeNull();
      return body;
    }
    async function select(property: string, candidate: string) {
      const before = await listing(property);
      const accepted = await editor.http(`/v1/subjects/${subject()}/candidates/${candidate}:accept`, {
        context: GLOBAL_CONTEXT,
        expected_head: null,
      });
      expect(accepted.status).toBe(200);
      const adopted = await editor.http(`/v1/subjects/${subject()}:adopt`, {
        context: GLOBAL_CONTEXT,
        property,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: before.adoption?.head ?? null,
      });
      expect(adopted.status).toBe(200);
    }
    return {
      runtime,
      owner,
      urls,
      acknowledgements,
      pending,
      resolved,
      subject,
      covers,
      listing,
      select,
      close,
      get importer() {
        return importer!;
      },
      get interrupted() {
        if (!interrupted) throw new Error('No native interruption reached');
        return interrupted;
      },
      get faultCount() {
        return faultCount;
      },
      async run(version = 0, crash = false) {
        armed = crash;
        controller = new AbortController();
        const payload = structuredClone(raw);
        payload.images.large = urls[version]!;
        if (version) payload.name = `Replacement observatory ${version}`;
        return importer!.runRecords(
          registration,
          (async function* () {
            yield { source: 'bangumi' as const, key: owner.external_id, revision: null, payload };
          })(),
          { signal: controller.signal },
        );
      },
      async reopen() {
        await importer!.close();
        importer = open();
      },
      async fence(media: string) {
        const taken = await editor.http(`/v1/media/${media}:takeDown`, { reason: 'Rights complaint during recovery' });
        expect(taken.status).toBe(200);
        const fenced = await editor.http('/v1/sourceFences:takedown', {
          source: owner.source,
          externalId: owner.external_id,
          fieldGroup: 'cover',
          reason: 'Rights complaint during recovery',
        });
        expect(fenced.status).toBe(200);
        const actual = await transport.fence(
          { source: owner.source, externalId: owner.external_id, fieldGroup: 'cover' },
          controller.signal.aborted ? new AbortController().signal : controller.signal,
        );
        expect(actual.fenced).toBe(true);
        expect(actual.securityRevision).toBeString();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type CoverRecovery = Awaited<ReturnType<typeof openCoverRecovery>>;
