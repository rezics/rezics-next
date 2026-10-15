import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { prefixWalkCursor, validatePrefixWalkResponse, type PrefixWalkEntry, type PrefixWalkRequest } from '../src/modules/search/prefix-walk.ts';
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


test('composed typeahead uses constant graph reads for one-batch and five-batch admission at 50 and 100 matching Works', async () => {
  const stack = await startMediaStack('typeahead-hydration-cost');
  const nativeWalk = stack.fuseki.prefixWalk.bind(stack.fuseki);
  try {
    const author = await stack.member('typeahead-cost-author');
    const prefix = `Hydration ${crypto.randomUUID()}`;
    const admittedOrdinals = new Set([0, 1, 10, 11, 18, 19, 24, 25, 28, 29]);
    const counts: number[] = [];
    for (const population of [50, 100]) {
      for (let index = population - 50; index < population; index++) {
        await stack.publicWork(author.actor, ['en'], `${prefix} ${index}`);
      }
      // Keep real composed graph/disclosure/card reads. The native fixture only
      // controls rejection placement, so the old page filler needs five batches
      // (10, 8, 6, 4, 2 entries) to admit the same ten cards.
      const entries: PrefixWalkEntry[] = [];
      let cursor: PrefixWalkRequest['cursor'] = null;
      let generation = '';
      do {
        const request: PrefixWalkRequest = { prefix: prefix.toLowerCase(), language: null, pageSize: 10, cursor };
        const response = validatePrefixWalkResponse(await nativeWalk(request), request);
        generation = response.generation; entries.push(...response.entries); cursor = response.cursor;
      } while (cursor !== null);
      expect(entries).toHaveLength(population);
      for (const batches of [1, 5]) {
        stack.fuseki.prefixWalk = async request => {
          const after = request.cursor === null ? ''
            : (JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as { after: string }).after;
          const remaining = entries.filter(entry => entry.key.localeCompare(after) > 0);
          const page = remaining.slice(0, request.pageSize).map(entry => ({ ...entry,
            rejected: batches === 5 && !admittedOrdinals.has(entries.indexOf(entry)) }));
          const more = remaining.length > page.length;
          return { entries: page, generation, examined: page.length,
            rejected: page.filter(entry => entry.rejected).length, more,
            cursor: more ? prefixWalkCursor(request, generation, page.at(-1)!.key) : null };
        };
        const before = stack.fuseki.queries;
        const response = await json(await stack.call('GET', `/v1/search/typeahead?prefix=${encodeURIComponent(prefix)}`));
        counts.push(stack.fuseki.queries - before);
        expect(response.items).toHaveLength(10);
        expect(response.hasMore).toBe(true);
      }
      stack.fuseki.prefixWalk = nativeWalk;
    }
    console.info('typeahead graph reads [50 one, 50 five, 100 one, 100 five]:', counts);
    expect(new Set(counts).size).toBe(1);
    expect(counts).toEqual([16, 16, 16, 16]);
  } finally { stack.fuseki.prefixWalk = nativeWalk; await stack.stop(); }
}, 120_000);
