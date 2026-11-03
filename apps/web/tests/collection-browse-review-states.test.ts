import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import {
  collectionLongNotesSparse,
  setCollectionStoryMode,
} from '../src/kernel/fake/collection-page-stories';
import collection from '../src/kernel/recorded/library-collection.json' with { type: 'json' };

const storiesPath = join(import.meta.dir, '../src/stories/library-collection.stories.tsx');
const collectionId = collection.collection.id;

type MemberPage = {
  members: {
    id: string;
    subjectId?: string;
    note: string | null;
    facts?: unknown;
    subject: { id: string; label: { value: string } } | null;
  }[];
  next: string | null;
};

function storyBlock(source: string, name: string) {
  const start = source.indexOf(`export const ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport const ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

async function membersPage(cursor?: string) {
  const fetchKernel = createStoryRecordedKernelFetch();
  const url = new URL(`http://kernel.local/v1/collections/${collectionId}/members`);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetchKernel(url);
  expect(response.status).toBe(200);
  return (await response.json()) as MemberPage;
}

test('Collection browse review exposes unlisted visitor and long-note sparse continuation', async () => {
  const source = await Bun.file(storiesPath).text();
  expect(storyBlock(source, 'UnlistedVisitor')).not.toContain('!dev');
  expect(storyBlock(source, 'LongNotesSparseContinuation')).toContain("render('long-notes-sparse')");
  expect(source).toContain('function render(');
  expect(source).toContain('<PageStory visitor={visitor} path={path}');
  expect(storyBlock(source, 'NotesAndDuplicates')).toContain('A second occurrence with its own note.');

  setCollectionStoryMode('notes-duplicates');
  const shortNotes = await membersPage();
  expect(shortNotes.members.some((member) => member.note === 'A second occurrence with its own note.')).toBe(true);
  expect(shortNotes.next).toBeNull();

  setCollectionStoryMode('long-notes-sparse');
  const first = await membersPage();
  const visible = first.members.filter((member) => member.subject);
  const withheld = first.members.filter((member) => member.subject === null);
  expect(visible).toHaveLength(2);
  expect(withheld).toHaveLength(1);
  expect(new Set(visible.map((member) => member.id))).toEqual(new Set(collectionLongNotesSparse.occurrenceIds));
  expect(visible.map((member) => member.id)).not.toContain(visible[0]!.subject!.id);
  expect(new Set(visible.map((member) => member.subject!.id)).size).toBe(1);
  expect(visible.map((member) => member.subject!.label.value)).toEqual([
    collectionLongNotesSparse.identity,
    collectionLongNotesSparse.identity,
  ]);
  expect(visible.map((member) => member.note)).toEqual([...collectionLongNotesSparse.notes]);
  expect(withheld[0]).toMatchObject({
    id: collectionLongNotesSparse.withheldOccurrenceId,
    subjectId: collectionLongNotesSparse.withheldSubjectId,
    subject: null,
    note: null,
  });
  expect(withheld[0]).not.toHaveProperty('facts');
  expect(first.next).toBe(collectionLongNotesSparse.next);

  const empty = await membersPage(collectionLongNotesSparse.next);
  expect(empty.members).toEqual([]);
  expect(empty.next).toBe(collectionLongNotesSparse.emptyCursor);
});
