import { expect, test } from 'bun:test';
import { changeAlbumSelection as change } from '../src/features/catalogue/album-correction-selection';
import { factLimit, sealFacts, sendFacts, type FactDraft } from '../src/features/catalogue/subject-facts';
import { albumExample, albumFixture, albumId } from '../src/kernel/fake/catalogue-album-profile';

test('Album selection at limit releases only the removed draft slot and keeps revisions private', async () => {
  const fixture = albumFixture();
  const read = await fixture.editors.facts.read();
  if (!read.ok) throw new Error('Expected album');
  const calls = fixture.calls.length;
  const properties = Array.from({ length: factLimit + 1 }, (_, index) => `album:fact${index}`);
  for (const property of properties) {
    read.release.properties[property] = { ...read.release.properties['schema:inLanguage']!, datatype: 'string' };
    read.release.types['schema:MusicAlbum']!.properties.push(property);
  }
  const stage = (drafts: FactDraft[], property: string) =>
    change(drafts, { kind: 'stage', read, property, source: null });
  const full = properties.slice(0, factLimit).reduce(stage, [] as FactDraft[]);
  expect(stage(full, properties[factLimit]!)).toBe(full);
  const revised = {
    ...full[1]!,
    included: false,
    statement: { ...full[1]!.statement, value: { type: 'value' as const, content: 'retained' } },
  };
  const edited = change(full, { kind: 'revise', draft: revised });
  const removed = change(edited, { kind: 'remove', property: properties[0]! });
  expect(removed).toEqual(edited.slice(1));
  expect(removed[0]).toBe(revised);
  expect(stage(removed, properties[factLimit]!)).toHaveLength(factLimit);
  expect(stage(removed, revised.property)).toBe(removed);
  expect(fixture.calls).toHaveLength(calls);
});

test('Partially resolved Album submission keeps exact unresolved commands and skips confirmed fields', async () => {
  const fixture = albumFixture();
  const read = await fixture.editors.facts.read();
  if (!read.ok) throw new Error('Expected album');
  let drafts: FactDraft[] = [];
  for (const property of ['schema:inLanguage', 'schema:isbn']) {
    read.release.types['schema:MusicAlbum']!.properties.push(property);
    drafts = change(drafts, { kind: 'stage', read, property, source: null });
    drafts.at(-1)!.statement.value = {
      type: 'value',
      content: property === 'schema:inLanguage' ? 'en' : '9781234567897',
    };
    drafts.at(-1)!.statement.references = albumExample().statements['schema:datePublished']![0]!.references;
  }
  drafts = sealFacts(albumId, read.release, drafts);
  for (const draft of drafts) draft.command!.session = 'original-session';
  const commands = drafts.map((draft) => draft.command!);
  const results = (property: string, result: FactDraft['result']) => {
    drafts = drafts.map((draft) => (draft.property === property ? { ...draft, result } : draft));
  };
  await sendFacts(
    drafts,
    async (command) =>
      command === commands[0]
        ? { ok: true, kind: 'proposed-awaiting-review', candidate: 'candidate', revision: 1, session: 'review-session' }
        : { ok: false, reason: 'uncertain' },
    results,
  );
  for (const draft of drafts) {
    expect(change(drafts, { kind: 'remove', property: draft.property })).toBe(drafts);
    expect(change(drafts, { kind: 'revise', draft: { ...draft, command: undefined, result: undefined } })).toBe(drafts);
  }
  const retried: unknown[] = [];
  await sendFacts(
    sealFacts(albumId, read.release, drafts),
    async (command) => {
      retried.push(command);
      return { ok: false, reason: 'uncertain' };
    },
    results,
  );
  expect(retried).toEqual([commands[1]]);
  expect(retried[0]).toBe(commands[1]);
  expect(drafts[0]!.result).toMatchObject({ candidate: 'candidate', session: 'review-session' });
});
