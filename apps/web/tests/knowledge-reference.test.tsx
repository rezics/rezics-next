import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { harness, viewer, csrfToken, credential, access } from './knowledge-history-harness';
import type { KnowledgePrivateOperations } from '../src/knowledge/private-page';
import type { KnowledgePrivateHead } from '../src/knowledge/private-knowledge';
import { writeReference } from '../src/knowledge/reference-model';
const documentId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const revisionA = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const revisionB = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const revisionC = '0192f3a0-6c1e-7b2a-9d4e-000000000014';
const address = { kind: 'resume' as const, notebookId, documentId };
function head(): KnowledgePrivateHead {
  const body = fromPlainText('A copied problem with its original source block.', 'blocks');
  const draft = writeReference(
    { body, references: [] },
    {
      id: 'copied-theorem',
      role: 'uses',
      sourceBlockId: body.doc.content![0]!.attrs!.id as string,
      target: { kind: 'revision', documentId, revisionId: revisionA, sha256: 'a'.repeat(64), blockId: 'statement' },
    },
    'Original exact theorem',
  );
  return {
    ...draft,
    accountId: viewer,
    notebookId,
    documentId,
    revisionId: revisionA,
    publicationId: null,
    title: 'Copied problem',
    language: 'en',
    licence: 'CC-BY-4.0',
    subjectIds: [notebookId],
  };
}
function operations(
  current: () => KnowledgePrivateHead,
  overrides: Partial<KnowledgePrivateOperations> = {},
): KnowledgePrivateOperations {
  return {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: current() }),
    createNotebook: async () => ({ state: 'unavailable' }),
    listNotebooks: async () => ({ state: 'unavailable' }),
    readOutline: async () => ({ state: 'unavailable' }),
    createDocument: async () => ({ state: 'unavailable' }),
    revise: async () => ({ state: 'uncertain' }),
    selectPublication: async () => ({ state: 'unavailable' }),
    ...overrides,
  };
}
async function choose(label: string, value: string) {
  const { act } = await import('react');
  const select = [...document.querySelectorAll('select')].find(
    (node) => node.labels?.[0]?.textContent?.trim() === label,
  )!;
  await act(async () => {
    select.value = value;
    const EventClass = select.ownerDocument.defaultView!.Event;
    select.dispatchEvent(new EventClass('change', { bubbles: true }));
  });
}
test('author exact definition beside a copied theorem; conflict reread retains manifest and exact retry freezes it', async () => {
  const page = await harness();
  let saved = head();
  let reads = 0;
  const commands: Parameters<KnowledgePrivateOperations['revise']>[0][] = [];
  const ops = operations(
    () => {
      reads++;
      return reads === 1 ? saved : { ...saved, revisionId: revisionB, title: 'Server head' };
    },
    {
      revise: async (intent) => {
        commands.push(intent);
        return commands.length === 1 ? { state: 'conflict', status: 412 } : { state: 'uncertain' };
      },
    },
  );
  try {
    const view = await page.mount(address, ops);
    await view.findText('Original exact theorem');
    await view.click(view.button('Add reference'));
    await choose('Target kind', 'revision');
    await view.setInput(await view.findInput('Document ID'), documentId);
    await view.setInput(await view.findInput('Revision ID'), revisionC);
    await view.setInput(await view.findInput('SHA-256 digest'), 'b'.repeat(64));
    await view.setInput(await view.findInput('Authored literal label'), 'Exact definition');
    expect(view.button('Save revision').disabled).toBe(true);
    await view.click(view.button('Apply reference'));
    await view.click(view.button('Save revision'));
    await view.findText('The document changed on the server. Your draft is retained for review.');
    await view.click(view.button('Read current version again'));
    await view.findText('Review current server version');
    await view.click(view.button('Use this reviewed version as the new base'));
    await view.click(view.button('Save revision'));
    await view.findText('The command outcome is unknown. Retry this exact command to obtain its native receipt.');
    await view.click(view.button('Retry exact command'));
    expect(commands).toHaveLength(3);
    expect(commands[1]).toBe(commands[2]);
    expect(Object.isFrozen(commands[1]!.references)).toBe(true);
    expect(commands[1]!.expectedHeadRevisionId).toBe(revisionB);
    expect(commands[1]!.references[0]).toEqual(saved.references![0]);
    expect(commands[1]!.body.doc.content![0]).toEqual(saved.body.doc.content![0]);
    expect(commands[1]!.references[1]!.target).toEqual({
      kind: 'revision',
      documentId,
      revisionId: revisionC,
      sha256: 'b'.repeat(64),
    });
  } finally {
    await page.close();
  }
});
test('reference repair blocks save until explicitly restoring the orphan; saved publication review retains exact identity', async () => {
  const page = await harness();
  let saved = head();
  saved = {
    ...saved,
    body: { ...saved.body, doc: { ...saved.body.doc, content: saved.body.doc.content!.slice(0, 1) } },
  };
  const published: unknown[] = [];
  const ops = operations(() => saved, {
    revise: async (intent) => {
      saved = { ...saved, ...intent, revisionId: revisionB };
      return { state: 'acknowledged', receipt: { documentId, revisionId: revisionB } };
    },
    selectPublication: async (intent) => {
      published.push(intent);
      saved = { ...saved, publicationId: revisionC };
      return { state: 'acknowledged', receipt: { documentId, publicationId: revisionC, revisionId: revisionB } };
    },
  });
  try {
    const view = await page.mount(address, ops);
    await view.findText('Review reference repairs before saving.');
    await view.setInput(await view.findInput('Document title'), 'Repaired problem');
    expect(view.button('Save revision').disabled).toBe(true);
    await view.click(view.button('Restore missing citation component'));
    await view.click(view.button('Save revision'));
    await view.findText('The current private head matches the acknowledged revision.');
    expect(saved.references![0]!.target?.kind).toBe('revision');
    await view.click(view.button('Review saved version'));
    view.expectText('Exact revision');
    view.expectText('a'.repeat(64));
    await view.click(view.button('Publish this exact version'));
    await view.findText('A separate private read observed the acknowledged publication identity.');
    expect(published[0]).toMatchObject({ revisionId: revisionB });
  } finally {
    await page.close();
  }
});
test('selected inspection retains only one result and retires late results on locale, session, exposure, source and address replacement', async () => {
  for (const change of ['locale', 'session', 'exposure', 'source', 'address'] as const) {
    const page = await harness();
    const saved = head();
    let calls = 0;
    let resolve!: (value: {
      state: 'ready';
      documentId: string;
      revisionId: string;
      sha256: string;
      title: string;
      body: KnowledgePrivateHead['body'];
    }) => void;
    const promise = new Promise<Parameters<typeof resolve>[0]>((yes) => {
      resolve = yes;
    });
    const ops = operations(() => saved, {
      inspectReference: async () => {
        calls++;
        return promise;
      },
    });
    try {
      const view = await page.mount(address, ops);
      await view.findText('Original exact theorem');
      expect(calls).toBe(0);
      await view.click(view.button('Inspect target'));
      expect(calls).toBe(1);
      const nextAccess =
        change === 'session'
          ? { ...access, csrfToken: 'next-csrf' }
          : change === 'exposure'
            ? { ...access, owner: 'next-exposure' }
            : access;
      await page.replace(
        change === 'address' ? { ...address, documentId: revisionC } : address,
        change === 'source' ? { ...ops } : ops,
        nextAccess,
        change === 'locale' ? 'de' : 'en',
      );
      resolve({
        state: 'ready',
        documentId,
        revisionId: revisionA,
        sha256: 'a'.repeat(64),
        title: 'Retired target secret',
        body: saved.body,
      });
      await page.flush();
      expect(document.body.textContent).not.toContain('Retired target secret');
    } finally {
      await page.close();
    }
  }
});
