import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

// M4 exit: a draft Work's cover is not a disclosure. Studio uploads a cover as a `public` asset and selects it as
// the Work's avatar (`apps/web/features/studio/cover-api.ts`), but delivery asks the Work's own disclosure: until
// the Work has a public Main selection, only a reader of the Work gets the summary, the selection URL and the
// bytes, and everyone else gets one indistinguishable answer.

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('g-530-cover');
afterAll(async () => { if (started) await (await started).stop(); });

test('G-530: a draft Work\'s cover is unavailable to anonymous, strangers and revoked writers, private to its readers, and public only with the Work', async () => {
  const { main, member, privateWork, call, accessPool, admission, env, contribution } = await stack();
  const writer = await member('writer');
  const revoked = await member('revoked-writer');
  const stranger = await member('stranger');
  const draft = await privateWork(writer.actor, `Draft with a cover ${randomUUID()}`);
  const id = draft.work.slice('https://rezics.com/id/'.length);
  await writer.grant(`work:read:${draft.work}`, 'work.read');
  await writer.grant(`media:avatar:${draft.work}`, 'media.avatar');
  await revoked.grant(`work:read:${draft.work}`, 'work.read');

  // The cover is public as an asset, selected for a Work that is still a draft.
  const cover = png(256, 256);
  const uploaded = await writer.upload(cover, 'public');
  const select = (asset: string, expectedSelection: string | null) => writer.send('PUT', `/v1/resources/${id}/avatar`,
    { profile: 'resource-avatar-selection-v1', expectedSelection, asset, crop: 'xywh=percent:0,0,100,100',
      actingSubject: writer.actor });
  const selected = await select(uploaded.asset, null);
  expect(selected.status).toBe(201);
  const first = (await selected.json() as { selection: string }).selection;
  const urlOf = (selection: string) => `/v1/media/avatars/${selection}`;

  type Summary = { disclosure: 'public' | 'restricted'; avatar: { kind: string; selection?: string; url?: string } };
  const summaryOf = async (as: typeof writer | null) => as ? as.read(`/v1/resources/${id}`) : call('GET', `/v1/resources/${id}`);
  const readBytes = (as: typeof writer | null, path: string, validator?: string) => {
    const url = new URL(`http://main.local${path}`);
    if (as) url.searchParams.set('actingSubject', as.actor);
    return main.handle(new Request(url, { headers: {
      ...(as ? { authorization: `Bearer ${as.token}` } : {}),
      ...(validator ? { 'if-none-match': validator } : {}),
    } }));
  };
  const avatarOf = (as: typeof writer | null, selection: string, validator?: string) => readBytes(as, urlOf(selection), validator);
  const representationOf = async (selection: string) => {
    const metadata = await writer.send('POST', '/v1/media/metadata', { items: [{ selection }], actingSubject: writer.actor });
    expect(metadata.status).toBe(200);
    return (await metadata.json()).items[0].url as string;
  };
  /** Status and exact body of a refusal: what a caller learns must not tell a draft from an absent selection. */
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });

  // The writer reads the restricted summary and the exact bytes, never cached by a shared cache.
  const own = await summaryOf(writer);
  expect(own.status).toBe(200);
  const ownBody = await own.json() as Summary;
  expect(ownBody).toMatchObject({ disclosure: 'restricted', avatar: { kind: 'image', selection: first, url: urlOf(first) } });
  const bytes = await avatarOf(writer, first);
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get('cache-control')).toBe('private, no-cache');
  expect(bytes.headers.get('etag')).toBe(`"${sha(cover)}"`);
  expect(sha(new Uint8Array(await bytes.arrayBuffer()))).toBe(sha(cover));
  // Asset disclosure alone cannot give a draft's representation shared-cache headers.
  const firstRepresentation = await representationOf(first);
  for (const path of [urlOf(first), firstRepresentation]) {
    const privateBytes = await readBytes(writer, path);
    expect(privateBytes.status).toBe(200);
    expect(privateBytes.headers.get('cache-control')).toBe('private, no-cache');
    const revalidated = await readBytes(writer, path, `"${sha(cover)}"`);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('cache-control')).toBe('private, no-cache');
    expect(revalidated.headers.get('etag')).toBe(`"${sha(cover)}"`);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
  }
  // A reader the Work was shared with sees the same, until the grant is revoked.
  expect((await avatarOf(revoked, first)).status).toBe(200);
  await accessPool.query(`UPDATE access.permission_grant SET active = false, generation = generation + 1
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read'`, [revoked.actor, `work:read:${draft.work}`]);
  for (const path of [urlOf(first), firstRepresentation]) {
    expect((await readBytes(revoked, path, `"${sha(cover)}"`)).status).toBe(404);
    expect((await readBytes(null, path, `"${sha(cover)}"`)).status).toBe(404);
  }

  // Anonymous, a stranger and the revoked reader get one answer for the summary and one for the avatar URL, and it
  // equals the answer for a selection that never existed.
  const unknown = await answer(await avatarOf(null, randomUUID()));
  expect(unknown.status).toBe(404);
  const refusals = [];
  for (const reader of [null, stranger, revoked]) {
    refusals.push({ summary: await answer(await summaryOf(reader)), avatar: await answer(await avatarOf(reader, first)) });
  }
  for (const refusal of refusals) {
    expect(refusal.summary.status).toBe(404);
    expect(refusal.avatar).toEqual(unknown);
    expect(refusal.summary).toEqual(refusals[0]!.summary);
  }
  const preview = await call('GET', `/v1/public-previews/${id}`);
  expect(preview.status).toBe(404);

  // Replacement: the old selection is no longer anything to anyone, the writer included.
  const replacementBytes = png(300, 200);
  const replacement = await writer.upload(replacementBytes, 'public');
  const replaced = await select(replacement.asset, first);
  expect(replaced.status).toBe(201);
  const second = (await replaced.json() as { selection: string }).selection;
  expect(second).not.toBe(first);
  expect(await answer(await avatarOf(writer, first))).toEqual(unknown);
  expect((await avatarOf(writer, second)).status).toBe(200);
  expect(await answer(await avatarOf(null, second))).toEqual(unknown);

  // Publication makes the Work, and so its cover, public; revalidated, not private.
  const text = await contribution(draft.work, writer.actor, 'en', `Published ${randomUUID()}`);
  const input = { context: { kind: 'main-version-default' as const, id: draft.mainVersion }, work: draft.work,
    contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const, actingSubject: writer.actor };
  const published = await selectMainDefault(env, admission(writer.actor, `publication:select:${draft.mainVersion}`,
    'publication.select', mainSelectionDigest(input)), input);
  expect(published.outcome).toBe('succeeded');
  const secondRepresentation = await representationOf(second);
  for (const reader of [null, stranger, revoked]) {
    const publicSummary = await summaryOf(reader);
    expect(publicSummary.status).toBe(200);
    expect(await publicSummary.json()).toMatchObject({ disclosure: 'public',
      avatar: { kind: 'image', selection: second, url: urlOf(second) } });
    const publicBytes = await avatarOf(reader, second);
    expect(publicBytes.status).toBe(200);
    expect(publicBytes.headers.get('cache-control')).toBe('public, no-cache');
    expect(publicBytes.headers.get('etag')).toBe(`"${sha(replacementBytes)}"`);
    expect(sha(new Uint8Array(await publicBytes.arrayBuffer()))).toBe(sha(replacementBytes));
    for (const path of [urlOf(second), secondRepresentation]) {
      const revalidated = await readBytes(reader, path, `"${sha(replacementBytes)}"`);
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('cache-control')).toBe('public, no-cache');
      expect(revalidated.headers.get('etag')).toBe(`"${sha(replacementBytes)}"`);
      expect((await revalidated.arrayBuffer()).byteLength).toBe(0);
    }
  }
  // The replaced selection stays unavailable after publication: publication discloses the current cover only.
  expect(await answer(await avatarOf(null, first))).toEqual(unknown);
}, 180_000);
