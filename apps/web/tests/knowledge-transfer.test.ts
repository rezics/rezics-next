import { expect, test } from 'bun:test';
import { KnowledgeTransferVisit, type KnowledgeTransferOperations } from '../src/knowledge/transfer-visit';
import type { KnowledgeCopyIntent, KnowledgeCopyResult } from '../src/knowledge/transfer';
import type { KnowledgeNavigationRequest } from '../src/knowledge/navigation-read';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const source = { representation: 'public' as const, documentId: id(1), revisionId: id(2) };
const notebook = {
  notebookId: id(10),
  subjectId: id(4),
  title: 'My private notebook',
  structureRevisionId: id(20),
  createdAt: '2026-11-10T00:00:00Z',
};
const parent = {
  placementId: id(30),
  documentId: id(31),
  parentPlacementId: null,
  position: '2',
  title: 'Selected parent',
};
const receipt = {
  notebookId: id(10),
  documentId: id(11),
  revisionId: id(12),
  placementId: id(13),
  structureRevisionId: id(14),
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(copy?: KnowledgeTransferOperations['copy']) {
  const reads: KnowledgeNavigationRequest[] = [],
    commands: KnowledgeCopyIntent[] = [],
    saves: string[] = [];
  let exports = 0,
    disposed = 0,
    current = true,
    retired: (() => void) | null = null;
  const operations: KnowledgeTransferOperations = {
    export: async () => ({ state: 'ready', bytes: `native-${++exports}` }),
    prepare: async () => ({ state: 'ready', viewer: id(99), csrfToken: 'csrf-1', credential: 'credential-1' }),
    navigate: async (request) => {
      reads.push(request);
      return {
        state: 'ready',
        page:
          request.kind === 'owned'
            ? {
                kind: 'owned',
                notebooks: request.cursor ? [] : [notebook],
                next: request.cursor ? null : 'opaque+next/=',
              }
            : {
                kind: 'outline',
                notebookId: request.notebookId,
                parentPlacementId: request.parentPlacementId,
                structureRevisionId: id(20 + reads.length),
                placements: request.parentPlacementId ? [] : [parent],
                next: null,
              },
      };
    },
    copy: async (intent) => {
      commands.push(intent);
      return copy ? copy(intent) : { state: 'uncertain' };
    },
    readback: async () => ({ state: 'unavailable' }),
    current: () => current,
    subscribeRetirement: (callback) => {
      retired = callback;
      return () => {
        retired = null;
      };
    },
  };
  const visit = new KnowledgeTransferVisit(source, operations, (bytes) => ({
    save: () => {
      saves.push(bytes);
      if (saves.length === 1) throw new Error('Browser refused download');
    },
    dispose: () => {
      disposed++;
    },
  }));
  visit.connect();
  return {
    visit,
    reads,
    commands,
    saves,
    operations,
    exports: () => exports,
    disposed: () => disposed,
    retire: () => {
      current = false;
      retired?.();
    },
  };
}

test('save retry reuses unchanged local bytes; fresh export reads admission again; retirement disposes bytes and stale callbacks', async () => {
  const f = fixture();
  await f.visit.exportFresh();
  expect(f.visit.snapshot().exportState).toBe('save-failed');
  f.visit.saveAgain();
  expect(f.saves).toEqual(['native-1', 'native-1']);
  expect(f.exports()).toBe(1);
  await f.visit.exportFresh();
  expect(f.saves).toEqual(['native-1', 'native-1', 'native-2']);
  expect(f.disposed()).toBe(1);
  f.retire();
  f.visit.saveAgain();
  await f.visit.exportFresh();
  expect(f.disposed()).toBe(2);
  expect(f.exports()).toBe(2);
  expect(f.visit.snapshot()).toMatchObject({ retired: true, page: null, notebook: null, receipt: null });
});

test('destination uses replacing pages with opaque cursors, explicit parent reads and immutable uncertain retry', async () => {
  const f = fixture();
  await f.visit.openCopy();
  f.visit.more();
  await flush();
  expect(f.visit.snapshot().page).toEqual({ kind: 'owned', notebooks: [], next: null });
  expect(f.reads).toEqual([{ kind: 'owned' }, { kind: 'owned', cursor: 'opaque+next/=' }]);
  f.visit.refresh();
  await flush();
  f.visit.chooseNotebook(notebook);
  await flush();
  f.visit.descend(parent);
  await flush();
  f.visit.review();
  f.visit.confirm();
  f.visit.confirm();
  await flush();
  expect(f.commands).toHaveLength(1);
  const intent = f.commands[0]!;
  expect(intent).toMatchObject({
    source,
    notebookId: id(10),
    parentPlacementId: id(30),
    expectedStructureRevisionId: id(25),
    binding: { credential: 'credential-1' },
  });
  f.visit.owned();
  f.visit.up();
  f.visit.refresh();
  f.visit.more();
  expect(f.reads).toHaveLength(5);
  f.visit.retryCopy();
  await flush();
  expect(f.commands).toHaveLength(2);
  expect(f.commands[1]).toBe(intent);
  expect(Object.isFrozen(intent)).toBe(true);
  expect(Object.isFrozen(intent.source)).toBe(true);
});

test('structure conflict retains choices but requires fresh destination review and a new command key', async () => {
  const f = fixture(async () => ({ state: 'conflict' }));
  await f.visit.openCopy();
  f.visit.chooseNotebook(notebook);
  await flush();
  f.visit.review();
  f.visit.confirm();
  await flush();
  expect(f.visit.snapshot()).toMatchObject({ copyState: 'conflict', notebook, reviewed: false });
  f.visit.confirm();
  f.visit.retryCopy();
  expect(f.commands).toHaveLength(1);
  f.visit.refresh();
  await flush();
  f.visit.confirm();
  expect(f.commands).toHaveLength(1);
  f.visit.review();
  f.visit.confirm();
  await flush();
  expect(f.commands[1]!.idempotencyKey).not.toBe(f.commands[0]!.idempotencyKey);
  expect(f.commands[1]!.expectedStructureRevisionId).not.toBe(f.commands[0]!.expectedStructureRevisionId);
});

test('receipt requires independent readback and never permits another POST while readback is unavailable', async () => {
  const f = fixture(async () => ({ state: 'acknowledged', receipt }));
  await f.visit.openCopy();
  f.visit.chooseNotebook(notebook);
  await flush();
  f.visit.review();
  f.visit.confirm();
  await flush();
  expect(f.visit.snapshot()).toMatchObject({ copyState: 'unavailable', receipt });
  await f.visit.openCopy();
  f.visit.confirm();
  expect(f.commands).toHaveLength(1);
});

test('source withdrawal retires public actions and late copy acknowledgement cannot revive a replaced visit', async () => {
  let resolve!: (result: KnowledgeCopyResult) => void;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.visit.openCopy();
  f.visit.chooseNotebook(notebook);
  await flush();
  f.visit.review();
  f.visit.confirm();
  f.retire();
  resolve({ state: 'acknowledged', receipt });
  await flush();
  expect(f.visit.snapshot()).toMatchObject({ retired: true, receipt: null });
  let lost = 0;
  const visit = new KnowledgeTransferVisit(
    source,
    { ...f.operations, current: () => true, export: async () => ({ state: 'not-found' }) },
    undefined,
    null,
    () => {
      lost++;
    },
  );
  await visit.exportFresh();
  expect(visit.snapshot().retired).toBe(true);
  expect(lost).toBe(1);
});
