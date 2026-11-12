import { expect, test } from 'bun:test';
import { serializeDocument } from '@rezics/document';
import { harness, viewer, csrfToken, credential, access } from './knowledge-history-harness';
import {
  knowledgeBody,
  knowledgeDocumentId as documentId,
  knowledgeRevisionId as revisionA,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';
import type { KnowledgePrivateOperations } from '../src/knowledge/private-page';
import type { KnowledgePrivateHead } from '../src/knowledge/private-knowledge';
import type {
  KnowledgeHistoryComparison,
  KnowledgeHistoryRead,
  KnowledgeHistoryCompareRead,
  KnowledgeHistoryRevision,
} from '../src/knowledge/history';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const revisionB = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const revisionC = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const address = { kind: 'resume' as const, notebookId, documentId };
function head(revisionId = revisionA, title = 'Saved opening'): KnowledgePrivateHead {
  return {
    accountId: viewer,
    notebookId,
    documentId,
    revisionId,
    title,
    language: 'en',
    licence: 'CC-BY-4.0',
    publicationId: null,
    subjectIds: [knowledgeSubjectId],
    body: knowledgeBody(title),
  };
}
function exact(revisionId: string): KnowledgeHistoryRevision {
  const saved = head(revisionId, `Exact saved ${revisionId}`);
  return { ...saved, source: serializeDocument(saved.body), sha256: 'a'.repeat(64), references: [], provenance: null };
}
function comparison(left = revisionA, right = revisionB): KnowledgeHistoryComparison {
  return { documentId, left: exact(left), right: exact(right) };
}
function page(next: string | null = null, revisions = [revisionB, revisionA]): KnowledgeHistoryRead {
  return {
    state: 'ready',
    page: {
      documentId,
      revisions: revisions.map((revisionId) => ({
        revisionId,
        title: `Saved ${revisionId}`,
        language: 'en',
        licence: 'CC-BY-4.0',
        sha256: 'a'.repeat(64),
        createdAt: '2026-11-01T12:00:00.000Z',
      })),
      next,
    },
  };
}
function operations(overrides: Partial<KnowledgePrivateOperations> = {}): KnowledgePrivateOperations {
  return {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: head() }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'uncertain' }),
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    history: {
      read: async () => page(),
      compare: async (_address, pair) => ({
        state: 'ready',
        comparison: comparison(pair.leftRevisionId, pair.rightRevisionId),
      }),
    },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('history reads one replacing page per action, preserves sparse continuation and retries the attempted opaque cursor', async () => {
  const mount = await harness();
  const cursors: Array<string | null> = [];
  let attempt = 0;
  let compareCalls = 0;
  const ops = operations({
    history: {
      read: async (_address, cursor, binding) => {
        expect(binding).toEqual({ viewer, csrfToken });
        cursors.push(cursor);
        attempt++;
        if (attempt === 1) return page('opaque +/= cursor', []);
        if (attempt === 2) throw new TypeError('Failed to fetch');
        if (attempt === 3) return { state: 'stale', status: 409 };
        return page(null, []);
      },
      compare: async () => {
        compareCalls++;
        return { state: 'unavailable' };
      },
    },
  });
  try {
    const view = await mount.mount(address, ops);
    await view.findInput('Document title');
    expect(cursors).toEqual([]);
    await view.click(view.button('Open revision history'));
    await view.findText('No revisions on this page. More continues the native history reading.');
    expect(cursors).toEqual([null]);
    await view.click(view.button('More revisions'));
    await view.findText('Revision history is unavailable.');
    await view.click(view.button('Retry this visit'));
    await view.findText('This history cursor has changed.');
    expect(cursors).toEqual([null, 'opaque +/= cursor', 'opaque +/= cursor']);
    await view.click(view.button('Restart history'));
    await view.findText('No saved revisions are available on this page.');
    expect(cursors).toEqual([null, 'opaque +/= cursor', 'opaque +/= cursor', null]);
    expect(compareCalls).toBe(0);
    await view.click(view.button('Return to draft'));
    expect(view.activeElement()).toBe(view.button('Open revision history'));
  } finally {
    await mount.close();
  }
});

test('exact comparison return retains the draft and publication selection; uncertain save keeps its original intent', async () => {
  const mount = await harness();
  const pairs: unknown[] = [];
  const saves: unknown[] = [];
  let readCalls = 0;
  let publicationCalls = 0;
  const ops = operations({
    read: async () => {
      readCalls++;
      return { state: 'ready', viewer, csrfToken, credential, head: head() };
    },
    revise: async (intent) => {
      saves.push(intent);
      return { state: 'uncertain' };
    },
    selectPublication: async () => {
      publicationCalls++;
      return { state: 'unavailable' };
    },
    history: {
      read: async () => page(),
      compare: async (current, pair, binding) => {
        pairs.push({ current, pair, binding });
        return { state: 'ready', comparison: comparison(pair.leftRevisionId, pair.rightRevisionId) };
      },
    },
  });
  try {
    const view = await mount.mount(address, ops);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Retained local words');
    await view.click(view.button('Review saved version'));
    await view.click(view.button('Save revision'));
    await view.findText('The command outcome is unknown.');
    await view.click(view.button('Open revision history'));
    await view.findText(`Saved ${revisionB}`);
    await view.click(view.radio('left', revisionB));
    await view.click(view.radio('right', revisionA));
    await view.click(view.button('Compare selected revisions'));
    await view.findText(`Exact saved ${revisionB}`);
    expect(pairs).toEqual([
      {
        current: { notebookId, documentId },
        pair: { leftRevisionId: revisionB, rightRevisionId: revisionA },
        binding: { viewer, csrfToken },
      },
    ]);
    await view.click(view.button('Back to revisions'));
    expect(view.activeElement()).toBe(view.button('Compare selected revisions'));
    await view.click(view.button('Return to draft'));
    expect(title.value).toBe('Retained local words');
    expect(title.disabled).toBe(true);
    expect(view.button('Publish this exact version')).toBeDefined();
    await view.click(view.button('Retry exact command'));
    expect(saves).toHaveLength(2);
    expect(saves[0]).toBe(saves[1]);
    expect(readCalls).toBe(1);
    expect(publicationCalls).toBe(0);
    expect(JSON.stringify(mount.cachedValues())).not.toContain('Exact saved');
  } finally {
    await mount.close();
  }
});

test('two editors resolve a stale-head save only after exact comparison, explicit head adoption and a deliberate save', async () => {
  const mount = await harness(2);
  let current = head();
  const intents: Array<Parameters<KnowledgePrivateOperations['revise']>[0]> = [];
  const pairs: unknown[] = [];
  const ops = operations({
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: current }),
    revise: async (intent) => {
      intents.push(intent);
      if (intent.expectedHeadRevisionId !== current.revisionId) return { state: 'conflict', status: 412 };
      current = { ...current, ...intent, revisionId: current.revisionId === revisionA ? revisionB : revisionC };
      return { state: 'acknowledged', receipt: { documentId, revisionId: current.revisionId } };
    },
    history: {
      read: async () => page(),
      compare: async (_current, pair) => {
        pairs.push(pair);
        return { state: 'ready', comparison: comparison() };
      },
    },
  });
  try {
    await mount.mount(address, ops);
    const first = mount.editor(0);
    const second = mount.editor(1);
    const firstTitle = await first.findInput('Document title');
    const secondTitle = await second.findInput('Document title');
    await first.setInput(firstTitle, 'First editor saved');
    await second.setInput(secondTitle, 'Second editor retained');
    await first.click(first.button('Save revision'));
    await first.findText('The current private head matches the acknowledged revision.');
    await second.click(second.button('Save revision'));
    await second.findText('The document changed on the server.');
    await second.click(second.button('Read current version again'));
    await second.findText('Review current server version');
    await second.click(second.button('Compare saved base and current head'));
    await second.findText('This is your retained local writing, not a saved revision.');
    expect(pairs).toEqual([{ leftRevisionId: revisionA, rightRevisionId: revisionB }]);
    expect(intents).toHaveLength(2);
    expect(secondTitle.value).toBe('Second editor retained');
    await second.click(second.button('Return to draft'));
    expect(second.button('Review current version before saving').disabled).toBe(true);
    await second.click(second.button('Use this reviewed version as the new base'));
    expect(intents).toHaveLength(2);
    await second.click(second.button('Save revision'));
    await second.findText('The current private head matches the acknowledged revision.');
    expect(intents[2]!.expectedHeadRevisionId).toBe(revisionB);
    expect(intents[2]!.title).toBe('Second editor retained');
    expect(current.revisionId).toBe(revisionC);
  } finally {
    await mount.close();
  }
});

test('retirement discards late history and pair bodies, callbacks and focus work', async () => {
  const mount = await harness();
  const latePage = deferred<KnowledgeHistoryRead>();
  const latePair = deferred<KnowledgeHistoryCompareRead>();
  const first = operations({ history: { read: () => latePage.promise, compare: () => latePair.promise } });
  try {
    const view = await mount.mount(address, first);
    await view.findInput('Document title');
    await view.click(view.button('Open revision history'));
    await mount.replace(
      address,
      operations(),
      { ...access, viewer: revisionC, csrfToken: 'next-csrf', owner: 'next-session' },
      'fr',
    );
    latePage.resolve(page(null, [revisionC]));
    await mount.flush();
    view.expectMissingText(`Saved ${revisionC}`);
    await mount.replace(address, first);
    latePage.resolve(page());
    // Use a fresh source for the comparison lifetime, then replace that source before its response arrives.
    const source = operations({ history: { read: async () => page(), compare: () => latePair.promise } });
    await mount.replace(address, source);
    await view.findInput('Document title');
    await view.click(view.button('Open revision history'));
    await view.findText(`Saved ${revisionB}`);
    await view.click(view.radio('left', revisionA));
    await view.click(view.radio('right', revisionB));
    await view.click(view.button('Compare selected revisions'));
    await mount.replace(address, operations());
    await view.findInput('Document title');
    const survivor = view.button('Open revision history');
    survivor.focus();
    latePair.resolve({ state: 'ready', comparison: comparison() });
    await mount.flush();
    view.expectMissingText(`Exact saved ${revisionA}`);
    expect(view.activeElement()).toBe(survivor);
    expect(JSON.stringify(mount.cachedValues())).not.toContain('Exact saved');
  } finally {
    await mount.close();
  }
});
