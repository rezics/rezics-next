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
  const { member, privateWork, call, accessPool, admission, env, contribution } = await stack();
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
  const avatarOf = async (as: typeof writer | null, selection: string) => as ? as.read(urlOf(selection))
    : call('GET', urlOf(selection));
  /** Status and exact body of a refusal: what a caller learns must not tell a draft from an absent selection. */
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });

  // The writer reads the restricted summary and the exact bytes, never cached by a shared cache.
  const own = await summaryOf(writer);
  expect(own.status).toBe(200);
  const ownBody = await own.json() as Summary;
  expect(ownBody).toMatchObject({ disclosure: 'restricted', avatar: { kind: 'image', selection: first, url: urlOf(first) } });
  const bytes = await avatarOf(writer, first);
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get('cache-control')).toBe('private, no-store');
  expect(bytes.headers.get('etag')).toBe(`"${sha(cover)}"`);
  expect(sha(new Uint8Array(await bytes.arrayBuffer()))).toBe(sha(cover));
  // A reader the Work was shared with sees the same, until the grant is revoked.
  expect((await avatarOf(revoked, first)).status).toBe(200);
  await accessPool.query(`UPDATE access.permission_grant SET active = false, generation = generation + 1
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read'`, [revoked.actor, `work:read:${draft.work}`]);

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
  }
  // The replaced selection stays unavailable after publication: publication discloses the current cover only.
  expect(await answer(await avatarOf(null, first))).toEqual(unknown);
}, 180_000);
