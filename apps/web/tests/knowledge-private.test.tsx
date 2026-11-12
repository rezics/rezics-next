import { expect, mock, test } from 'bun:test';
import { harness } from './knowledge-history-harness';
import * as start from '../.storybook/react-start';
import {
  knowledgeBody,
  knowledgeDocumentId,
  knowledgeRevisionId,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';
import type { KnowledgePrivateHead } from '../src/knowledge/private-knowledge';
import type {
  KnowledgePrivateOperations,
  KnowledgePrivatePageAccess,
  KnowledgePrivatePageAddress,
} from '../src/knowledge/private-page';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const nextRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const savedRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const otherDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const csrfToken = 'private-story-session';
const credential = 'private-story-credential';
const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'session-1/exposure-1',
  read: 'available',
  createNotebook: 'available',
  listNotebooks: 'available',
  readOutline: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'available',
};

function head(
  documentId = knowledgeDocumentId,
  revisionId = knowledgeRevisionId,
  title = 'A private field note',
): KnowledgePrivateHead {
  return {
    accountId: viewer,
    notebookId,
    documentId,
    revisionId,
    publicationId: null,
    title,
    language: 'en',
    licence: 'LicenseRef-rezics-terms',
    subjectIds: [knowledgeSubjectId],
    body: knowledgeBody('Private body from the exact current head.'),
  };
}

test('creation retains the acknowledged notebook, then retries only the frozen root document command', async () => {
  const page = await harness();
  const calls: Array<{ kind: string; input: unknown }> = [];
  let documentAttempt = 0;
  const operations: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({ state: 'unavailable', status: 503 }),
    createNotebook: async (intent) => {
      calls.push({ kind: 'notebook', input: structuredClone(intent) });
      return { state: 'acknowledged', receipt: { notebookId, structureRevisionId: knowledgeRevisionId } };
    },
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async (intent) => {
      calls.push({ kind: 'document', input: structuredClone(intent) });
      if (documentAttempt++ === 0) return { state: 'unavailable', status: 503 };
      return {
        state: 'acknowledged',
        receipt: {
          notebookId,
          documentId: knowledgeDocumentId,
          placementId: savedRevisionId,
          revisionId: nextRevisionId,
          structureRevisionId: savedRevisionId,
        },
      };
    },
    revise: async () => ({ state: 'unavailable', status: 503 }),
  };
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await view.click(view.button('Create notebook'));
    await view.findText('The native notebook command was acknowledged. Its receipt is held for document creation.');
    await view.click(view.button('Create document'));
    await view.findText('Private Knowledge is unavailable right now. Retry this same visit.');
    view.expectText(notebookId);
    expect(calls.filter(({ kind }) => kind === 'notebook')).toHaveLength(1);
    await view.click(view.button('Retry exact command'));
    await view.findText('The native document command was acknowledged.');
    expect(calls.filter(({ kind }) => kind === 'notebook')).toHaveLength(1);
    const documentCalls = calls.filter(({ kind }) => kind === 'document');
    expect(documentCalls).toHaveLength(2);
    expect(documentCalls[0]!.input).toEqual(documentCalls[1]!.input);
    expect(documentCalls[0]!.input).toMatchObject({
      notebookId,
      structureRevisionId: knowledgeRevisionId,
      parentPlacementId: null,
      subjectId: knowledgeSubjectId,
    });
    view.expectLink('/en/knowledge/notebooks/' + notebookId + '/documents/' + knowledgeDocumentId);
  } finally {
    await page.close();
  }
});

test('conflict keeps the draft, explicit reread supplies the next CAS head, and uncertain retry is exact', async () => {
  const page = await harness();
  let readCount = 0;
  let reviseCount = 0;
  const revisions: Array<Parameters<KnowledgePrivateOperations['revise']>[0]> = [];
  const operations: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => {
      readCount++;
      const current =
        readCount === 1
          ? head()
          : readCount === 2
            ? head(knowledgeDocumentId, nextRevisionId, 'Current server version')
            : head(knowledgeDocumentId, savedRevisionId, 'My retained draft');
      return { state: 'ready', viewer, csrfToken, credential, head: current };
    },
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async (intent) => {
      revisions.push(structuredClone(intent));
      if (reviseCount++ === 0) return { state: 'conflict', status: 412 };
      if (reviseCount === 2) return { state: 'uncertain' };
      return { state: 'acknowledged', receipt: { documentId: knowledgeDocumentId, revisionId: savedRevisionId } };
    },
  };
  try {
    const view = await page.mount({ kind: 'resume', notebookId, documentId: knowledgeDocumentId }, operations);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'My retained draft');
    await view.click(view.button('Save revision'));
    await view.findText('The document changed on the server. Your draft is retained for review.');
    expect(title.value).toBe('My retained draft');

    await view.click(view.button('Read current version again'));
    await view.findText('Review current server version');
    view.expectText('Current server version');
    view.expectText('My retained draft');
    await view.click(view.button('Use this reviewed version as the new base'));
    await view.click(view.button('Save revision'));
    await view.findText('The command outcome is unknown. Retry this exact command to obtain its native receipt.');
    await view.click(view.button('Retry exact command'));
    await view.findText(
      'The native revision command was acknowledged. Readback is checking the current head separately.',
    );
    await view.findText('The current private head matches the acknowledged revision.');

    expect(revisions).toHaveLength(3);
    expect(revisions[0]!.expectedHeadRevisionId).toBe(knowledgeRevisionId);
    expect(revisions[1]!.expectedHeadRevisionId).toBe(nextRevisionId);
    expect(revisions[1]).toEqual(revisions[2]);
    expect(revisions[1]!.title).toBe('My retained draft');
  } finally {
    await page.close();
  }
});

test('viewer, exposure, locale, source and exact-address replacement retire late private reads', async () => {
  const page = await harness();
  const pending = deferred<Awaited<ReturnType<KnowledgePrivateOperations['read']>>>();
  const first: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => pending.promise,
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'unavailable', status: 503 }),
  };
  const replacement: KnowledgePrivateOperations = {
    ...first,
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: head(otherDocumentId, nextRevisionId, 'Replacement current head'),
    }),
  };
  try {
    const originalAddress: KnowledgePrivatePageAddress = {
      kind: 'resume',
      notebookId,
      documentId: knowledgeDocumentId,
    };
    const nextAddress: KnowledgePrivatePageAddress = { kind: 'resume', notebookId, documentId: otherDocumentId };
    const view = await page.mount(originalAddress, first);
    await page.replace(nextAddress, replacement, { ...access, owner: 'session-2/exposure-3' }, 'fr');
    await view.findText('Replacement current head');
    pending.resolve({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: head(knowledgeDocumentId, knowledgeRevisionId, 'Late retired private head'),
    });
    await page.flush();
    view.expectMissingText('Late retired private head');
    view.expectText('Replacement current head');
    expect(JSON.stringify(page.cachedValues())).not.toContain('Private body from the exact current head.');
  } finally {
    await page.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
