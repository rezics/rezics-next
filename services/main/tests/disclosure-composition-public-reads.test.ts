import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { ensureFixtureScopeGate } from '../src/modules/access/fixture-authority.ts';

async function json(response: Response, expected = 200) {
  const text = await response.text();
  expect(response.status, text).toBe(expected);
  return JSON.parse(text);
}

test('production composition without ancestry sources serves public search, typeahead and name and cover summaries', async () => {
  const stack = await startMediaStack('disclosure-public-reads');
  try {
    const author = await stack.member('public-reader-author');
    const published = await stack.publicWork(author.actor, ['en'], 'Ancestry fallback catalogue');
    const search = () => stack.call('POST', '/v1/queries/page', { body: {
      profile: 'public-main-phrase-page-v1', phrase: 'Ancestry fallback', language: 'en', pageSize: 20,
    } }).then(response => json(response));
    const typeahead = () => stack.call('GET', '/v1/search/typeahead?prefix=Ancestry').then(response => json(response));
    const summary = () => stack.call('POST', '/v1/resources/summaries', { body: {
      profile: 'resource-summary-batch-v1', resources: [published.work], language: 'en',
    } }).then(response => json(response));
    expect((await search()).results).toMatchObject([{ work: published.work, matchedField: 'title' }]);
    expect((await typeahead()).items).toMatchObject([{ work: published.work }]);
    expect((await summary()).summaries).toMatchObject([{ reference: published.work,
      status: 'available', name: { value: published.title }, avatar: { kind: 'fallback' } }]);

    await author.grant(`media:avatar:${published.work}`, 'media.avatar');
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3,
      background: { r: 40, g: 90, b: 150 } } }).png().toBuffer();
    const asset = await author.upload(new Uint8Array(bytes));
    await json(await author.send('PUT', `/v1/resources/${published.work.slice(-36)}/avatar`, {
      profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: asset.asset,
      crop: null, actingSubject: author.actor,
    }), 201);
    expect((await summary()).summaries).toMatchObject([{ reference: published.work,
      status: 'available', name: { value: published.title }, avatar: { kind: 'image' } }]);

    // Closing the existing Work read gate must still hide its name and cover.
    await ensureFixtureScopeGate(stack.accessPool, `work:read:${published.work}`, { open: false });
    expect((await typeahead()).items).toEqual([]);
    expect((await summary()).summaries).toEqual([{ reference: published.work, status: 'unavailable' }]);
    await ensureFixtureScopeGate(stack.accessPool, `work:read:${published.work}`, { open: true });
    expect((await summary()).summaries).toMatchObject([{ status: 'available', avatar: { kind: 'image' } }]);
  } finally { await stack.stop(); }
}, 120_000);
