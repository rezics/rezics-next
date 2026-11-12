import { expect, test } from 'bun:test';
import { harness, access, viewer, csrfToken, credential } from './knowledge-history-harness';
import { knowledgeBody, knowledgeSubjectId } from '../src/stories/knowledge-document-fixtures';
import type { KnowledgePrivateOperations } from '../src/knowledge/private-page';
import type { KnowledgeLifecycle, KnowledgeLifecycleIntent, KnowledgeLifecycleRead } from '../src/knowledge/lifecycle';

const address = {
  kind: 'resume' as const,
  notebookId: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const admitted = {
  ...access,
  lifecycleRead: 'available' as const,
  trash: 'available' as const,
  restore: 'available' as const,
};
const binding = { viewer, csrfToken, credential };
const active: KnowledgeLifecycle = {
  notebookId: address.notebookId,
  documentId: address.documentId,
  structureRevisionId,
  generation: '0',
  state: 'active',
  restoreUntil: null,
};
const trashed: KnowledgeLifecycle = {
  ...active,
  generation: '1',
  state: 'trashed',
  restoreUntil: '2099-12-01T00:00:00.000Z',
};
const head = {
  ...address,
  accountId: viewer,
  revisionId: structureRevisionId,
  publicationId: null,
  title: 'Current private document',
  language: 'en',
  licence: 'LicenseRef-rezics-terms',
  subjectIds: [knowledgeSubjectId],
  body: knowledgeBody('Private text stays hidden in trash.'),
};
const ready = (lifecycle: KnowledgeLifecycle): KnowledgeLifecycleRead => ({ state: 'ready', lifecycle, binding });
function operations(lifecycle: NonNullable<KnowledgePrivateOperations['lifecycle']>): KnowledgePrivateOperations {
  return {
    lifecycle,
    prepare: async () => ({ state: 'ready', ...binding }),
    read: async () => ({ state: 'ready', ...binding, head }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'unavailable', status: 503 }),
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
  };
}

test('reload in trash reads metadata only; restore rereads lifecycle then private head before editing', async () => {
  const page = await harness();
  let value = trashed;
  const calls: string[] = [];
  const base = operations({
    read: async (routed, expected) => {
      calls.push('lifecycle');
      expect(routed).toMatchObject({ notebookId: address.notebookId, documentId: address.documentId });
      expect(expected).toEqual({ viewer, csrfToken });
      return ready(value);
    },
    change: async (intent) => {
      calls.push(intent.action);
      expect(intent).toMatchObject({
        action: 'restore',
        expectedGeneration: '1',
        expectedStructureRevisionId: structureRevisionId,
        binding,
      });
      value = { ...active, generation: '2' };
      return { state: 'acknowledged', receipt: { ...value, complete: true, reason: null } };
    },
  });
  let release!: (result: Awaited<ReturnType<KnowledgePrivateOperations['read']>>) => void;
  const ops: KnowledgePrivateOperations = {
    ...base,
    read: async () => {
      calls.push('head');
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  try {
    const view = await page.mount(address, ops, admitted);
    await view.findText('Document in trash');
    view.expectText('Restore before:');
    view.expectMissingText(head.title);
    view.expectMissingText('Document title');
    view.expectMissingText('Private text stays hidden in trash.');
    expect(calls).toEqual(['lifecycle']);
    await view.click(view.button('Restore document'));
    await view.click(view.button('Confirm restore'));
    await view.findText('Preparing your private Knowledge visit');
    expect(calls).toEqual(['lifecycle', 'restore', 'lifecycle', 'head']);
    view.expectMissingText('Document title');
    release({ state: 'ready', ...binding, head: { ...head, title: 'Restored authoritative head' } });
    await page.flush();
    expect((await view.findInput('Document title')).value).toBe('Restored authoritative head');
    expect(page.cachedValues().some((item) => JSON.stringify(item)?.includes('Restored authoritative head'))).toBe(
      false,
    );
  } finally {
    await page.close();
  }
});

test('dirty draft prevents trash; review locks editing and an uncertain command retries the frozen intent', async () => {
  const page = await harness();
  let value = active;
  const intents: KnowledgeLifecycleIntent[] = [];
  const ops = operations({
    read: async () => ready(value),
    change: async (intent) => {
      intents.push(structuredClone(intent));
      if (intents.length === 1) return { state: 'uncertain' };
      value = trashed;
      return { state: 'acknowledged', receipt: { ...trashed, complete: true, reason: null } };
    },
  });
  try {
    const view = await page.mount(address, ops, admitted);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Unsaved title');
    expect(view.button('Move document to trash').disabled).toBe(true);
    await view.setInput(title, head.title);
    await view.click(view.button('Move document to trash'));
    expect(intents).toHaveLength(0);
    expect(title.disabled).toBe(true);
    await view.click(view.button('Cancel'));
    expect(title.disabled).toBe(false);
    await view.click(view.button('Move document to trash'));
    await view.click(view.button('Confirm move to trash'));
    await view.findText('The command outcome is unknown.');
    expect(title.disabled).toBe(true);
    await view.click(view.button('Retry exact command'));
    await view.findText('Document in trash');
    expect(intents).toHaveLength(2);
    expect(intents[1]).toEqual(intents[0]);
    view.expectMissingText('Document title');
    view.expectMissingText('Publication');
  } finally {
    await page.close();
  }
});

test('subtree no-effect and structure conflict reread native state without reporting a completed trash', async () => {
  const page = await harness();
  let value = active;
  const intents: KnowledgeLifecycleIntent[] = [];
  const ops = operations({
    read: async () => ready(value),
    change: async (intent) => {
      intents.push(intent);
      if (intents.length === 1)
        return { state: 'acknowledged', receipt: { ...active, complete: false, reason: 'subtree_work_required' } };
      value = { ...active, generation: '3', structureRevisionId: viewer };
      return { state: 'conflict', status: 412 };
    },
  });
  try {
    const view = await page.mount(address, ops, admitted);
    await view.findInput('Document title');
    await view.click(view.button('Move document to trash'));
    await view.click(view.button('Confirm move to trash'));
    await view.findText('No lifecycle change was completed');
    view.expectMissingText('Document in trash');
    await view.click(view.button('Move document to trash'));
    await view.click(view.button('Confirm move to trash'));
    await view.findText('Review the freshly read status');
    await view.click(view.button('Move document to trash'));
    await view.click(view.button('Confirm move to trash'));
    expect(intents[2]).toMatchObject({ expectedGeneration: '3', expectedStructureRevisionId: viewer });
    expect(intents[2]!.idempotencyKey).not.toBe(intents[1]!.idempotencyKey);
  } finally {
    await page.close();
  }
});

test('expiry and denied restore never disclose the editor; replaced visits ignore late lifecycle responses', async () => {
  const page = await harness();
  let commands = 0;
  const ops = operations({
    read: async () => ready({ ...trashed, restoreUntil: '2000-01-01T00:00:00.000Z' }),
    change: async () => {
      commands++;
      return { state: 'denied', status: 403 };
    },
  });
  try {
    const view = await page.mount(address, ops, admitted);
    await view.findText('The restore window has ended.');
    expect(view.button('Restore document').disabled).toBe(true);
    expect(commands).toBe(0);
    const current = operations({ ...ops.lifecycle!, read: async () => ready(trashed) });
    await page.replace(address, current, admitted);
    await view.findText('Document in trash');
    await view.click(view.button('Restore document'));
    await view.click(view.button('Confirm restore'));
    await view.findText('This account cannot access the private document or action.');
    view.expectMissingText('Restore document');
    view.expectMissingText(head.title);
    let release!: (value: KnowledgeLifecycleRead) => void;
    const late = operations({
      ...ops.lifecycle!,
      read: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await page.replace(address, late, admitted);
    await page.replace(address, current, { ...admitted, owner: 'replacement', viewer: structureRevisionId });
    release(ready(active));
    await page.flush();
    view.expectMissingText('Document title');
    view.expectMissingText(head.title);
  } finally {
    await page.close();
  }
});
