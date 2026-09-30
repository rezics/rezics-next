import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('releases keep kind and status, closed records, web snapshots and edition language lists', async () => {
  const stack = await startMediaStack('releases', { profileCredits: true });
  try {
    const editor = await stack.member('release-editor');
    const work = await stack.publicWork(editor.actor, ['zh'], '紅樓夢');
    // Creating a release fixture does not confer catalogue editing authority.
    // The credit writer must hold G-508's exact Work editor mandate.
    const authorCredit = async (target: { work: string }) => {
      const path = `/v1/works/${target.work.slice(-36)}`;
      const { revision } = await json<{ revision: string }>(await stack.call('GET', path));
      const credit = { profile: 'native-agent-credit-v1', credit: id(), agent: editor.actor, role: 'author',
        expectedWorkHead: revision, actingSubject: editor.actor };
      expect((await editor.send('POST', `${path}/agent-credits`, credit)).status).toBe(403);
      await editor.grant(`work:edit:${target.work}`, 'work.edit');
      await json(await editor.send('POST', `${path}/agent-credits`, credit), 201);
      expect((await json<{ items: { agent: string; role: string }[] }>(await stack.call('GET', `${path}/agent-credits`))).items)
        .toContainEqual(expect.objectContaining({ agent: editor.actor, role: 'author' }));
    };
    await authorCredit(work);
    const root = `/v1/works/${work.work.slice(-36)}`;
    const editionId = id();
    const v1 = await json<{ revision: string }>(await editor.send('PUT', `${root}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: editor.actor,
      state: { kind: 'edition', id: editionId, status: 'active', title: { value: '程甲本', language: 'zh-Hant' },
        contentLanguage: 'zh-hant', editionStatement: null, publisher: null, publicationYear: 1791, isbn13: null },
    }));
    expect((await json<{ items: { id: string }[] }>(await stack.call('GET', `${root}/editions?contentLanguage=zh-hant`)))
      .items.map(item => item.id)).toContain(editionId);
    const v2Id = id();
    const v2 = await json<{ revision: string }>(await editor.send('PUT', `${root}/metadata`, {
      profile: 'work-metadata-details-v2', expectedHead: null, actingSubject: editor.actor,
      state: { kind: 'edition', id: v2Id, status: 'active', title: { value: '红楼梦', language: 'zh-Hans' },
        contentLanguages: ['zh-Hans', 'zh-Hant'], isTranslation: false, originalLanguages: [],
        titleLanguage: 'zh-Hans', tracklistLanguage: null, editionStatement: null, publisher: '人民文学出版社',
        publicationYear: 1982, isbn13: null },
    }));
    expect(v2.revision).not.toBe(v1.revision);
    const listed = await json<{ items: { id: string; contentLanguages?: string[] }[] }>(
      await stack.call('GET', `${root}/editions?contentLanguage=zh-Hant`));
    expect(listed.items.find(item => item.id === v2Id)?.contentLanguages).toEqual(['zh-Hans', 'zh-Hant']);
    expect((await editor.send('PUT', `${root}/metadata`, { profile: 'work-metadata-details-v2', expectedHead: null,
      actingSubject: editor.actor, state: { kind: 'edition', id: id(), status: 'active',
        title: { value: 'Many', language: 'en' }, contentLanguages: ['mul'], isTranslation: false,
        originalLanguages: [], titleLanguage: null, tracklistLanguage: null, editionStatement: null,
        publisher: null, publicationYear: null, isbn13: null } })).status).toBe(400);

    const printed = id();
    const release = await json<{ release: string; revision: string }>(await editor.send('PUT',
      `${root}/releases/${printed.slice(-36)}`, { profile: 'release-v1', expectedHead: null,
        actingSubject: editor.actor, id: printed, kind: 'formal', status: 'official',
        contentLanguages: ['zh-Hant'], isTranslation: false, originalLanguages: [], titleLanguage: 'zh-Hant',
        tracklistLanguage: null, title: { value: '紅樓夢', language: 'zh-Hant' }, editionStatement: null,
        publisher: '萃文書屋', publicationYear: 1791, isbn13: null, originalUrl: null, fixedRelease: null,
        coverage: null, evidence: null }));
    expect((await editor.send('PUT', `${root}/releases/${printed.slice(-36)}`, { profile: 'release-v1',
      expectedHead: release.revision, actingSubject: editor.actor, id: printed, kind: 'formal', status: 'official',
      contentLanguages: ['en'], isTranslation: true, originalLanguages: ['zh'], titleLanguage: 'en',
      tracklistLanguage: null, title: { value: 'The Story of the Stone', language: 'en' }, editionStatement: null,
      publisher: null, publicationYear: 1973, isbn13: null, originalUrl: null, fixedRelease: null,
      coverage: null, evidence: null })).status).toBe(400);
    const unofficial = id();
    await json(await editor.send('PUT', `${root}/releases/${unofficial.slice(-36)}`, { profile: 'release-v1',
      expectedHead: null, actingSubject: editor.actor, id: unofficial, kind: 'formal', status: 'unofficial',
      contentLanguages: ['zh-Hans'], isTranslation: false, originalLanguages: [], titleLanguage: 'zh-Hans',
      tracklistLanguage: null, title: { value: '红楼梦', language: 'zh-Hans' }, editionStatement: null,
      publisher: null, publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null,
      coverage: null, evidence: null }));
    const page = await json<{ items: { id: string; status: string }[] }>(await stack.call('GET', `${root}/releases`));
    expect(new Set(page.items.map(item => item.id))).toEqual(new Set([printed, unofficial]));
    expect(page.items.find(item => item.id === unofficial)?.status).toBe('unofficial');
    const virtual = id();
    expect((await editor.send('PUT', `${root}/releases/${virtual.slice(-36)}`, { profile: 'release-v1', expectedHead: null,
      actingSubject: editor.actor, id: virtual, kind: 'virtual', status: 'official', contentLanguages: [],
      isTranslation: false, originalLanguages: [], titleLanguage: null, tracklistLanguage: null,
      title: { value: 'Virtual', language: 'en' }, editionStatement: null, publisher: null, publicationYear: null,
      isbn13: null, originalUrl: null, fixedRelease: null, coverage: { scope: '1-20', complete: false },
      evidence: null })).status).toBe(400);

    const serial = await stack.publicWork(editor.actor, ['zh'], '星港夜話');
    await authorCredit(serial);
    const serialRoot = `/v1/works/${serial.work.slice(-36)}`;
    const web = id();
    await json(await editor.send('PUT', `${serialRoot}/releases/${web.slice(-36)}`, { profile: 'release-v1',
      expectedHead: null, actingSubject: editor.actor, id: web, kind: 'web', status: 'official',
      contentLanguages: ['zh'], isTranslation: false, originalLanguages: [], titleLanguage: 'zh',
      tracklistLanguage: null, title: { value: '星港夜話', language: 'zh' }, editionStatement: null,
      publisher: null, publicationYear: null, isbn13: null, originalUrl: 'https://example.com/star-harbor',
      fixedRelease: null, coverage: null, evidence: null }));
    const text = '星港夜話 第一回至第十回';
    const snapshot = id();
    const saved = await json<{ byteDigest: string; receipt: string;
      sourcePosition: { dataEpoch: string; sequence: string } }>(await editor.send('POST',
      `${serialRoot}/web-publications/${web.slice(-36)}/snapshots`, { profile: 'web-snapshot-v1',
        actingSubject: editor.actor, id: snapshot, acquisition: 'fixture',
        bytesBase64: Buffer.from(text, 'utf8').toString('base64'), mediaType: 'text/plain',
        fetchedAt: '2024-03-01T00:00:00.000Z', coverage: { scope: 'chapters 1-10', complete: false } }));
    expect(saved.byteDigest).toBe(createHash('sha256').update(text).digest('hex'));
    const eventId = `urn:rezics:event:${hash(saved.receipt)}`;
    const envelope = await readMainOutboxEnvelope(stack.fuseki, {
      batchId: `urn:rezics:outbox:${hash(saved.receipt)}`, ...saved.sourcePosition,
      routingEpoch: stack.env.lineage.routingEpoch, eventIds: [eventId],
    }, eventId);
    expect(envelope.type).toBe('com.rezics.release.changed.v1');
    expect(envelope.data.receipt.snapshot).toBe(snapshot);
    const second = await json<{ byteDigest: string }>(await editor.send('POST',
      `${serialRoot}/web-publications/${web.slice(-36)}/snapshots`, { profile: 'web-snapshot-v1',
        actingSubject: editor.actor, id: id(), acquisition: 'fixture',
        bytesBase64: Buffer.from('星港夜話 第一回至第二十回', 'utf8').toString('base64'), mediaType: 'text/plain',
        fetchedAt: '2024-06-01T00:00:00.000Z', coverage: { scope: 'chapters 1-20', complete: false } }));
    const read = await json<{ snapshots: { byteDigest: string }[]; originalUrl: string }>(
      await stack.call('GET', `${serialRoot}/releases/${web.slice(-36)}`));
    expect(read.originalUrl).toBe('https://example.com/star-harbor');
    expect(read.snapshots.map(item => item.byteDigest).sort()).toEqual([saved.byteDigest, second.byteDigest].sort());
  } finally { await stack.stop(); }
}, 30_000);
