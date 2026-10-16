import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/anime/anime-manga-and-vn-hub-parts-wholes-and-relations.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { readDatedAnimeHub } from './anime-hub-recorded-page.ts';
import { animeRelationsReads, readAnimeRelationsConnections, readAnimeRelationsPreview,
  recordedAnimeRelationsVisit } from './anime-relations-recorded-page.ts';
import { readSuppliedContents } from './games-hub-recorded-page.ts';

const record = answers as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });

function visit(persona: AnswerPersona, entry: number) {
  const selected = recordedAnimeRelationsVisit(record, persona, entry);
  const replay = recordedFetch(record, persona, selected.selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const faults: unknown[] = [];
  const main = browserMainApi('https://record.invalid', { anonymous: persona === 'visitor', fetcher: (async (...args) => {
    try { return await replay.fetcher(...args); } catch (error) { faults.push(error); throw error; }
  }) as typeof fetch });
  return { ...selected, main, faults, reads: animeRelationsReads({ main, actingSubject: selected.actingSubject }) };
}

for (const persona of personas) {
  test(`${persona}: native identities and author credit survive the production reader`, async () => {
    const identities = [
      ['Animated seed islands', 'https://schema.org/TVSeries'],
      ['Seed islands manga', 'https://schema.org/Book'],
      ['Seed islands visual novel', 'https://schema.org/VideoGame'],
    ] as const;
    for (const [index, [title, type]] of identities.entries()) {
      const source = visit(persona, index + 1);
      expect(Boolean(source.actingSubject)).toBe(persona !== 'visitor');
      const page = await readDatedAnimeHub(source.main, source.actingSubject, source.id);
      expect(page.header).toEqual({ ok: true, data: source.header.answer });
      if (!page.header.ok) throw new Error('Recorded public Work must load');
      expect(page.header.data.title.value).toStartWith(title);
      expect(page.header.data.types).toContain(type);
      expect(page.projection.ok && page.projection.data.registry.type).toBe(type);
      expect(page.agentCredits.ok && page.agentCredits.data.items).toContainEqual(expect.objectContaining({
        role: 'author', displayName: 'Outcome owner', identityStatus: 'active',
      }));
      expect(source.faults).toEqual([]);
    }
  });

  test(`${persona}: connections, hub previews and contents keep the disclosed inventory`, async () => {
    for (const entry of [1, 2, 3]) {
      const source = visit(persona, entry);
      const [view, preview, contents] = await Promise.all([
        readAnimeRelationsConnections(source.reads, source.id, { grain: 'series' }),
        readAnimeRelationsPreview(source.reads, source.id),
        readSuppliedContents(source, source.id, {}),
      ]);
      if (!view.parts.ok || !view.relations.ok || !view.wholes.ok || !preview.parts.ok || !contents.ok)
        throw new Error('Recorded public composition must load');
      const count = persona === 'owner' ? 3 : 2;
      expect(view.parts.data.parts).toHaveLength(count);
      expect(view.relations.data.items).toHaveLength(count);
      expect(contents.data.items).toHaveLength(count);
      expect(preview.parts.data.parts).toEqual(view.parts.data.parts);
      expect(view.wholes.data.wholes).toEqual([]);
      expect(view.parts.data.next).toBeNull();
      expect(view.relations.data.next).toBeNull();
      const names = [...view.names.values()].filter(item => item.status === 'available');
      expect(names.some(item => item.name.value.startsWith('First seed journey'))).toBe(true);
      expect(names.some(item => item.name.value.startsWith('Second seed journey'))).toBe(true);
      expect(names.some(item => item.name.value.startsWith('Private seed journey'))).toBe(persona === 'owner');
      for (const relation of view.relations.data.items) {
        expect(relation.kind).toBe('occurrence');
        expect(relation.rendering?.viewingRole).toBe('source');
        expect(relation.rendering?.projections).toContainEqual(expect.objectContaining({ fromRole: 'source', toRole: 'target' }));
      }
      expect(source.faults).toEqual([]);
    }
  });

  test(`${persona}: wholes and the private composition do not inherit platform authority`, async () => {
    const part = visit(persona, 4);
    const view = await readAnimeRelationsConnections(part.reads, part.id, { grain: 'series' });
    const preview = await readAnimeRelationsPreview(part.reads, part.id);
    if (!view.wholes.ok || !preview.wholes.ok) throw new Error('Recorded wholes must load');
    expect(view.wholes.data.wholes).toHaveLength(persona === 'owner' ? 4 : 3);
    expect(preview.wholes.data.wholes.length).toBeLessThanOrEqual(3);
    expect(preview.wholes.data.next !== null).toBe(persona === 'owner');
    const privatePage = visit(persona, 5);
    const page = await readDatedAnimeHub(privatePage.main, privatePage.actingSubject, privatePage.id);
    if (persona === 'owner') {
      expect(page.header.ok).toBe(true);
      const contents = await readSuppliedContents(privatePage, privatePage.id, {});
      expect(contents.ok && contents.data.items).toHaveLength(1);
    } else {
      expect(privatePage.header.status).toBe(404);
      expect(page.header).toEqual({ ok: false, failure: 'missing', status: 404, problem: privatePage.header.answer });
      expect(page).not.toHaveProperty('projection');
    }
    expect([...part.faults, ...privatePage.faults]).toEqual([]);
  });
}
