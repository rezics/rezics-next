import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { convertBangumi } from '@rezics/conversion/bangumi';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { resumeSelectedCover } from '../src/cross-media-covers.ts';
import { createMediaResolver } from '../src/media-resolver.ts';
import { RecordBindings } from '../src/record-bindings.ts';

test('unchanged selected cover recovers its original receipt across a rejected replacement', async () => {
  const db = new Database(':memory:');
  const bindings = new RecordBindings(db);
  try {
    const owner = { source: 'bangumi_cross_media', external_id: '101' };
    const containerId = '00000000-0000-4000-8000-000000000301';
    const mediaId = '00000000-0000-4000-8000-000000000302';
    const replacementId = '00000000-0000-4000-8000-000000000303';
    const signal = AbortSignal.timeout(1000);
    const record = {
      external_id: owner.external_id,
      record_revision: 'unversioned',
      record: { id: 101, type: 1, name: 'Book' },
    };
    const create = convertBangumi(record, { source: owner.source }).proposals[0]!;
    const key = owner.source + ':101:create';
    bindings.prepare(owner, key, { commands: [{ ...create, key }] });
    bindings.acknowledge(owner, key, { results: [{ key, status: 201, value: { id: containerId, revision: 1 } }] });
    const intentFor = (file: string) =>
      convertBangumi(
        { ...record, record: { ...record.record, images: { large: 'https://lain.bgm.tv/pic/cover/l/' + file } } },
        { source: owner.source, subjectId: containerId },
      ).mediaImportIntents[0]!;
    const original = intentFor('first.jpg');
    const replacement = intentFor('replacement.jpg');
    let interrupt = true;
    const posts: string[] = [];
    const polls: string[] = [];
    const resolver = createMediaResolver({
      bindings,
      sleep: async () => {},
      port: {
        readFence: async () => ({ fenced: false, securityRevision: null }),
        async importFromUrl(bytes, mediaKey) {
          posts.push(mediaKey);
          if (interrupt) throw new Error('Interrupted before reservation');
          const { sourceUrl } = JSON.parse(bytes) as MediaImportRequest;
          const id = sourceUrl === original.sourceUrl ? mediaId : replacementId;
          return { status: 202, body: { media: { id, containerId, purpose: 'cover', state: 'reserved' } } };
        },
        async importStatus(id) {
          polls.push(id);
          const { credit, provenance } = id === mediaId ? original : replacement;
          const observed =
            id === mediaId
              ? { state: 'available', byteCount: 32, mediaType: 'image/png', sha256: 'a'.repeat(64) }
              : {
                  state: 'rejected',
                  byteCount: null,
                  mediaType: null,
                  sha256: null,
                  rejection: { code: 'source-denied' },
                };
          return {
            status: 200,
            body: { media: { id, containerId, purpose: 'cover', credit, provenance, ...observed } },
          };
        },
      },
    });
    const deliver = (intent: MediaImportRequest, deferPending: boolean) =>
      resolver.resolve({ owner, containerId, signal, mediaImportIntents: [intent], deferPending });
    const resume = (intent: MediaImportRequest) =>
      resumeSelectedCover(
        {
          bindings,
          resolver: {
            async resolve(input) {
              expect(input).toMatchObject({ owner, subject: containerId, deferPending: false });
              const result = await deliver(input.mediaImportIntents[0]!, false);
              return result.outcome === 'resolved' && result.assets[0]?.outcome === 'available'
                ? { status: 'available', mediaIds: result.mediaIds }
                : { status: 'rejected' };
            },
          },
        },
        { owner, containerId, intent, signal },
      );

    expect(await resume(original)).toBeUndefined();
    await expect(deliver(original, false)).rejects.toThrow('Interrupted before reservation');
    interrupt = false;
    await resume(original);
    const first = {
      status: 'available',
      mediaState: 'available',
      mediaKey: posts[0]!,
      mediaId,
      credit: original.credit,
      provenance: original.provenance,
    };
    expect(JSON.stringify(await resume(original))).toBe(JSON.stringify(first));
    expect(await resume(replacement)).toBeUndefined();
    await deliver(replacement, true);
    await resume(replacement);
    const rejected = await resume(replacement);
    expect(rejected).toMatchObject({ status: 'rejected', mediaState: 'rejected', mediaKey: posts[2] });
    expect(rejected?.mediaId).toBeUndefined();
    expect(bindings.mediaIds(owner)).toEqual({});
    expect(bindings.mediaIds(owner, first.mediaKey)).toEqual({ cover: mediaId });
    expect(JSON.stringify(await resume(original))).toBe(JSON.stringify(first));
    expect(posts).toEqual([first.mediaKey, first.mediaKey, rejected!.mediaKey]);
    expect(polls).toEqual([mediaId, replacementId]);
  } finally {
    bindings.close();
    db.close();
  }
});
