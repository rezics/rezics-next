import './support/cloudflare-workers';
import { expect, test } from 'bun:test';
import {
  arcExample,
  arcAddress,
  arcId,
  workId,
  otherWorkId,
  characterId,
} from '../src/features/catalogue/story-arc-reader/examples';
import { arcStreams } from '../src/features/catalogue/story-arc-reader/model';

test('directed arc memberships retain native order, distinct slots, qualifiers and sources without target hydration', async () => {
  const fixture = arcExample();
  const page = await fixture.read();
  if (!page.ok || !page.stream) throw new Error('Expected admitted arc');
  expect(page.stream.key).toBe('inverse:rezics:storyArc');
  expect(page.rows.map((row) => row.holder)).toEqual([workId, otherWorkId]);
  expect(page.rows.map((row) => row.statement?.qualifiers[0]?.value.content)).toEqual(['2', '1']);
  expect(page.rows[0]?.statement).toEqual(fixture.first.links[0]?.assertion);
  expect(page.rows[0]?.statement?.references).toEqual(fixture.first.links[0]?.assertion?.references);
  expect(fixture.calls.map((url) => url.pathname)).toEqual([`/v1/subjects/${arcId}`, `/v1/subjects/${arcId}/links`]);
  const next = await fixture.read({ ...arcAddress, stream: page.stream.key, cursor: page.next! });
  expect(next.ok && next.rows[0]?.holder).toBe(workId);
  expect(next.ok && next.rows[0]?.statementId).not.toBe(page.rows[0]?.statementId);
  const work = await fixture.read({ ...arcAddress, id: workId });
  expect(work.ok && work.stream?.direction).toBe('forward');
  expect(work.ok && work.rows[0]?.summary?.id).toBe(arcId);
  const sequence = await fixture.read({ ...arcAddress, stream: 'forward:rezics:sideStoryOf' });
  expect(sequence.ok && sequence.stream?.kind).toBe('sequence');
  expect(sequence.ok && sequence.rows[0]?.statement).toEqual(fixture.sequence.relations[0]?.statement);
});

test('arc-qualified appearances use one filtered work stream and fail closed on mismatched association or bounds', async () => {
  const fixture = arcExample();
  const address = { ...arcAddress, id: workId, arc: arcId };
  const page = await fixture.read(address);
  expect(page.ok && page.stream?.kind).toBe('appearance');
  expect(page.ok && page.rows[0]?.summary?.id).toBe(characterId);
  expect(fixture.calls[1]?.searchParams.get('filter')).toBe(arcId);
  expect(fixture.calls).toHaveLength(2);
  const invalid = structuredClone(fixture.appearances);
  invalid.relations[0]!.statement.qualifiers = [];
  fixture.respond(invalid);
  expect(await fixture.read(address)).toEqual({ ok: false, reason: 'unavailable' });
  fixture.respond({ ...fixture.first, links: Array(21).fill(fixture.first.links[0]) });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  fixture.respond({ ...fixture.first, links: [fixture.first.links[0]!, fixture.first.links[0]!] });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  fixture.respond({ ...fixture.first, next: 'repeat' });
  expect(await fixture.read({ ...arcAddress, stream: 'inverse:rezics:storyArc', cursor: 'repeat' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  fixture.respond({
    ...fixture.first,
    links: [{ ...fixture.first.links[0]!, summary: { ...fixture.first.links[0]!.summary!, id: characterId } }],
  });
  expect(await fixture.read()).toEqual({ ok: false, reason: 'unavailable' });
  delete fixture.release.properties['schema:character']!.relation!.filter;
  expect(arcStreams(fixture.release, 'wd:Q689445', 'en', arcId)).toEqual([]);
  const unsupported = await arcExample('unsupported').read();
  expect(unsupported.ok && unsupported.stream).toBeUndefined();
  fixture.respond({ ...fixture.first, links: [], next: null });
  const empty = await fixture.read();
  expect(empty.ok && empty.stream).toBeDefined();
  expect(empty.ok && empty.rows).toEqual([]);
  fixture.fail(403);
  expect(await fixture.read()).toEqual({ ok: false, reason: 'withheld' });
});
