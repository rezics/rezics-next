import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const raw = await response.text();
  expect({ status: response.status, ...(response.status === expected ? {} : { raw }) }).toEqual({ status: expected });
  return JSON.parse(raw) as T;
}
type Receipt = { revision: string; replayed: boolean; sourcePosition: { sequence: string } };
const releaseBody = (actingSubject: string, release = id()) => ({
  profile: 'release-v1' as const, expectedHead: null as string | null, actingSubject,
  id: release, kind: 'formal' as 'formal' | 'web', status: 'official' as const,
  contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en',
  tracklistLanguage: null, title: { value: 'Paperback', language: 'en' }, editionStatement: null,
  publisher: null as string | null, publicationYear: null, isbn13: null, originalUrl: null as string | null,
  fixedRelease: null, coverage: null, evidence: null as string | null,
});

test('release creation and correction retain their basis across an unrelated commit', async () => {
  const stack = await startMediaStack('release-concurrency');
  try {
    const editor = await stack.member('release-editor');
    const work = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const root = `/v1/works/${work.work.slice(-36)}/releases`;
    const body = () => releaseBody(editor.actor);
    const put = (record: ReturnType<typeof body>, key = randomUUID()) =>
      editor.send('PUT', `${root}/${record.id.slice(-36)}`, record, key);
    const nativeCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let interleave: (() => Promise<void>) | undefined;
    stack.fuseki.commandWithReceipt = async envelope => {
      if (interleave && envelope.update.includes('rv:ReleaseRevision')) {
        const pending = interleave;
        interleave = undefined;
        await pending();
      }
      return nativeCommand(envelope);
    };
    let unrelated: Receipt | undefined;
    const schedule = () => { interleave = async () => { unrelated = await json<Receipt>(await put(body())); }; };
    const record = body(), key = randomUUID();
    schedule();
    const created = await json<Receipt>(await put(record, key));
    expect(BigInt(created.sourcePosition.sequence)).toBeGreaterThan(BigInt(unrelated!.sourcePosition.sequence));
    expect(await json(await put(record, key))).toMatchObject({ ...created, replayed: true });
    const correction = { ...record, expectedHead: created.revision, publisher: 'Corrected publisher', evidence: id() };
    schedule();
    const corrected = await json<Receipt>(await put(correction));
    expect(corrected.revision).not.toBe(created.revision);
    expect(BigInt(corrected.sourcePosition.sequence)).toBeGreaterThan(BigInt(unrelated!.sourcePosition.sequence));
    const stale = await put({ ...correction, publisher: 'Stale publisher' });
    expect(await json(stale, 409)).toMatchObject({ code: 'release_basis_changed' });
    expect(await json(await editor.read(`${root}/${record.id.slice(-36)}`)))
      .toMatchObject({ revision: corrected.revision, publisher: 'Corrected publisher' });
    const next = { ...correction, expectedHead: corrected.revision, publisher: 'Concurrent publisher' };
    let winner: Receipt | undefined;
    interleave = async () => { winner = await json<Receipt>(await put(next)); };
    const lostKey = randomUUID();
    expect(await json(await put({ ...next, publisher: 'Losing publisher' }, lostKey), 409))
      .toMatchObject({ code: 'release_basis_changed' });
    expect(await json(await put({ ...next, publisher: 'Losing publisher' }, lostKey), 409))
      .toMatchObject({ code: 'release_basis_changed' });
    expect(await json(await editor.read(`${root}/${record.id.slice(-36)}`)))
      .toMatchObject({ revision: winner!.revision, publisher: 'Concurrent publisher' });
  } finally { await stack.stop(); }
}, 30_000);

test('realizations, covered releases, snapshots and editions accept unrelated commits during preparation', async () => {
  const stack = await startMediaStack('release-component-concurrency');
  try {
    const editor = await stack.member('component-editor');
    const work = await stack.publicWork(editor.actor);
    await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const root = `/v1/works/${work.work.slice(-36)}`;
    const nativeCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    let pending = false, unrelated: Receipt | undefined;
    stack.fuseki.commandWithReceipt = async envelope => {
      if (pending && envelope.update.includes('rv:commandFamily')) {
        pending = false;
        const sibling = releaseBody(editor.actor);
        unrelated = await json<Receipt>(await editor.send('PUT', `${root}/releases/${sibling.id.slice(-36)}`, sibling));
      }
      return nativeCommand(envelope);
    };
    const write = async (method: string, path: string, body: object) => {
      pending = true;
      const result = await json<Receipt>(await editor.send(method, path, body));
      expect(pending).toBe(false);
      expect(BigInt(result.sourcePosition.sequence)).toBeGreaterThan(BigInt(unrelated!.sourcePosition.sequence));
      return result;
    };
    await json(await editor.send('PUT', `${root}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: editor.actor,
      state: { kind: 'header', originalTitle: { value: 'Original title', language: 'en' }, localized: [] },
    }));
    const realization = id();
    const realized = await write('PUT', `${root}/realizations/${realization.slice(-36)}`, {
      profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor, id: realization,
      language: 'en', kind: 'translation', translators: [editor.actor], publishers: [editor.actor],
      source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified', evidence: id(),
    });
    const covered = id();
    const saved = await write('PUT', `${root}/releases/${covered.slice(-36)}`, {
      profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: covered,
      kind: 'formal', status: 'official', title: { value: 'Covered release', language: 'en' },
      titleLanguage: 'en', tracklistLanguage: null, editionStatement: null, publisher: null,
      publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
      identifiers: [], platform: null, territory: null,
      coverage: [{ realization, revision: realized.revision, completeness: 'complete' }],
    });
    expect(await json(await editor.read(`${root}/releases/${covered.slice(-36)}`)))
      .toMatchObject({ revision: saved.revision, coverage: [{ realization, revision: realized.revision }] });
    const web = { ...releaseBody(editor.actor), kind: 'web', originalUrl: 'https://example.com/serial' };
    await json(await editor.send('PUT', `${root}/releases/${web.id.slice(-36)}`, web));
    const snapshot = id();
    await write('POST', `${root}/web-publications/${web.id.slice(-36)}/snapshots`, {
      profile: 'web-snapshot-v1', actingSubject: editor.actor, id: snapshot, acquisition: 'fixture',
      bytesBase64: Buffer.from('Chapter one').toString('base64'), mediaType: 'text/plain',
      fetchedAt: '2024-03-01T00:00:00.000Z', coverage: { scope: 'chapter 1', complete: false },
    });
    expect(await json(await editor.read(`${root}/releases/${web.id.slice(-36)}`)))
      .toMatchObject({ snapshots: [{ id: snapshot }] });
    for (const profile of ['work-metadata-details-v1', 'work-metadata-details-v2']) {
      const edition = id();
      const edited = await write('PUT', `${root}/metadata`, {
        profile, expectedHead: null, actingSubject: editor.actor,
        state: { kind: 'edition', id: edition, status: 'active', title: { value: 'Edition', language: 'en' },
          editionStatement: null, publisher: null, publicationYear: null, isbn13: null,
          ...(profile === 'work-metadata-details-v1' ? { contentLanguage: 'en' } : {
            contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
          }) },
      });
      expect(await json(await editor.read(`${root}/editions/${edition.slice(-36)}`)))
        .toMatchObject({ id: edition, revision: edited.revision, status: 'active' });
    }
  } finally { await stack.stop(); }
}, 60_000);
