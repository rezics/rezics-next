import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { SeedApi } from './api.ts';
import { arrangeBook, readBookOutline } from './book-outline.ts';
import { classicGroups, classicTextPlan } from './classics-text.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const book = id(1), structure = id(2), reader = { token: 'author', actingSubject: id(3) };

/** An in-memory Main for one Book: contents per level, and composition changes on the current head. */
function stand(chapters: readonly string[]) {
  let head = 0, next = 100;
  type Node = { occurrence: string; parent: string; role: 'group' | 'chapter'; target: string | null;
    label: { value: string; language: string } | null };
  let nodes: Node[] = chapters.map(target => ({ occurrence: id(next++), parent: structure, role: 'chapter', target,
    label: null }));
  const posts: object[] = [];
  const place = (node: Node, parent: string, position: 'first' | 'last' | { after: string }) => {
    nodes = nodes.filter(entry => entry !== node);
    node.parent = parent;
    const siblings = nodes.filter(entry => entry.parent === parent);
    const at = position === 'first' ? siblings.length ? nodes.indexOf(siblings[0]!) : nodes.length
      : position === 'last' ? siblings.length ? nodes.indexOf(siblings.at(-1)!) + 1 : nodes.length
        : nodes.findIndex(entry => entry.occurrence === position.after) + 1;
    nodes.splice(at, 0, node);
  };
  const api: Pick<SeedApi, 'get' | 'getPublic' | 'post'> = {
    get: async <T>(path: string) => {
      const parent = new URL(`http://main${path}`).searchParams.get('parent') ?? structure;
      return { compositionRevision: id(10_000 + head), nextCursor: null,
        items: nodes.filter(node => node.parent === parent).map(node => ({ ...node, selectedRevision: null })) } as T;
    },
    getPublic: async () => { throw new Error('the author reads'); },
    post: async <T>(_path: string, body: unknown) => {
      const change = body as { expectedHead: string; operations: Array<{ op: string; occurrence?: string;
        parent: string; position: 'first' | { after: string }; label?: { value: string; language: string } }> };
      expect(change.expectedHead).toBe(id(10_000 + head));
      posts.push(change);
      for (const operation of change.operations) {
        if (operation.op === 'insert') {
          place({ occurrence: id(next++), parent: operation.parent, role: 'group', target: null,
            label: operation.label ?? null }, operation.parent, operation.position);
        } else place(nodes.find(node => node.occurrence === operation.occurrence)!, operation.parent, operation.position);
      }
      head++;
      return {} as T;
    },
  };
  return { api, posts };
}

test('a Book is divided into its planned volumes in place, and a replay sends nothing', async () => {
  const [one, two, three, prologue] = [id(51), id(52), id(53), id(50)];
  const main = stand([prologue, one, two, three]);
  const groups = [{ title: 'Letters', division: 'part' as const, chapters: [prologue] },
    { title: 'Volume I', division: 'volume' as const, chapters: [one, two] },
    { title: 'Volume II', division: 'volume' as const, chapters: [three] }];
  const input = { work: book, structure, language: 'en', reader, groups, key: 'test' };
  expect(await arrangeBook(main.api, input)).toEqual({ changes: 6 });
  const outline = await readBookOutline(main.api, book, 'en', reader);
  expect(outline.items.map(item => item.label?.value ?? item.target)).toEqual(['Letters', prologue,
    'Volume I', one, two, 'Volume II', three]);
  expect(await arrangeBook(main.api, input)).toEqual({ changes: 0 });
  // A plan that names fewer chapters leaves the others where they stand, and sends nothing.
  expect(await arrangeBook(main.api, { ...input, groups: groups.map(group => ({ ...group, chapters: [] })) }))
    .toEqual({ changes: 0 });
  expect(main.posts).toHaveLength(6);
});

test('the classics sample opens each of Pride and Prejudice’s volumes and puts Frankenstein’s letters in a part', () => {
  const plans = classicTextPlan(resolve(import.meta.dir, '../../..'));
  const pride = plans.find(plan => plan.book.id === 'pride')!;
  expect(pride.chapters.map(chapter => chapter.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 24',
    'Chapter 43']);
  expect(classicGroups('pride', pride.chapters)).toEqual([
    { title: 'Volume I', division: 'volume', chapters: [0, 1, 2] },
    { title: 'Volume II', division: 'volume', chapters: [3] },
    { title: 'Volume III', division: 'volume', chapters: [4] }]);
  const frankenstein = plans.find(plan => plan.book.id === 'frankenstein')!;
  expect(classicGroups('frankenstein', frankenstein.chapters)).toEqual([
    { title: 'Letters', division: 'part', chapters: [0, 1, 2, 3] }]);
  expect(classicGroups('alice', plans.find(plan => plan.book.id === 'alice')!.chapters)).toEqual([]);
});
