import { afterAll, expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { installPostReadingDom } from './post-reading-dom';
import { useKnowledgeLifecycle, type KnowledgeLifecycleController } from '../src/knowledge/lifecycle-controller';
import type {
  KnowledgeLifecycle,
  KnowledgeLifecycleOperations,
  KnowledgeLifecycleRead,
  KnowledgeLifecycleResult,
} from '../src/knowledge/lifecycle';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
afterAll(() => dom.restore());
const first = { notebookId: 'notebook', documentId: 'first' };
const second = { ...first, documentId: 'second' };
const binding = { viewer: 'viewer', csrfToken: 'csrf', credential: 'encrypted' };
const active: KnowledgeLifecycle = {
  ...first,
  structureRevisionId: 'structure',
  generation: '0',
  state: 'active',
  restoreUntil: null,
  restoreProgress: null,
};
const ready = (lifecycle = active, credentials = binding): KnowledgeLifecycleRead => ({
  state: 'ready',
  lifecycle,
  binding: credentials,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function mount(operations: KnowledgeLifecycleOperations) {
  const host = dom.window.document.createElement('main') as unknown as HTMLElement;
  const root = createRoot(host);
  let controller!: KnowledgeLifecycleController;
  let address = first;
  let expected = binding;
  const retired: string[] = [];
  const frames: KnowledgeLifecycleController[] = [];
  function Panel() {
    controller = useKnowledgeLifecycle({
      address,
      expected,
      operations,
      admission: 'available',
      trashAdmission: 'available',
      restoreAdmission: 'available',
      onRetire: (state) => retired.push(state),
    });
    frames.push(controller);
    return <output>{controller.lifecycle?.documentId ?? controller.readState}</output>;
  }
  const render = () =>
    root.render(
      <StrictMode>
        <Panel />
      </StrictMode>,
    );
  await act(async () => {
    render();
  });
  return {
    get current() {
      return controller;
    },
    retired,
    frames,
    async replace(nextAddress = address, nextExpected = expected) {
      address = nextAddress;
      expected = nextExpected;
      frames.length = 0;
      await act(async () => {
        render();
      });
    },
    async close() {
      await act(async () => root.unmount());
    },
  };
}

test('late old reads cannot release the replacement read; current refresh alone adopts completion', async () => {
  const reads: ReturnType<typeof deferred<KnowledgeLifecycleRead>>[] = [];
  const page = await mount({
    read: async () => {
      const read = deferred<KnowledgeLifecycleRead>();
      reads.push(read);
      return read.promise;
    },
    change: async () => {
      throw new Error('refresh must never write');
    },
  });
  try {
    expect(reads).toHaveLength(2); // Strict Mode retires the first effect generation.
    await page.replace(second);
    await act(async () => {
      reads[0]!.resolve(ready());
      reads[1]!.resolve({ state: 'denied', status: 403 });
    });
    expect(page.current.lifecycle).toBeNull();
    expect(page.retired).toEqual([]);
    await act(async () => {
      void page.current.reread();
    });
    expect(reads).toHaveLength(3);
    const restoring: KnowledgeLifecycle = {
      ...active,
      ...second,
      state: 'trashed',
      restoreUntil: '2099-01-01T00:00:00Z',
      restoreProgress: { processedDocuments: '64', pendingPlacements: '1' },
    };
    await act(async () => {
      reads[2]!.resolve(ready(restoring));
    });
    expect(page.current.lifecycle).toEqual(restoring);
    await act(async () => {
      void page.current.reread();
      void page.current.reread();
    });
    expect(reads).toHaveLength(4);
    expect(page.current.editing).toBe(false);
    await act(async () => {
      reads[3]!.resolve(ready({ ...active, ...second }));
    });
    expect(page.current.editing).toBe(true);
    expect(page.current.revision).toBe(2);
  } finally {
    await page.close();
  }
});

test('a pending former command cannot migrate its intent or release a current command; retry remains exact', async () => {
  const commands: {
    intent: Parameters<KnowledgeLifecycleOperations['change']>[0];
    result: ReturnType<typeof deferred<KnowledgeLifecycleResult>>;
  }[] = [];
  let reads = 0;
  const page = await mount({
    read: async (address, expected) => {
      reads++;
      return ready({ ...active, ...address }, { ...binding, ...expected });
    },
    change: async (intent) => {
      const result = deferred<KnowledgeLifecycleResult>();
      commands.push({ intent, result });
      return result.promise;
    },
  });
  try {
    await act(async () => page.current.review(false));
    await page.replace(first, { ...binding, viewer: 'replacement', csrfToken: 'rotated' });
    expect(page.frames.every((frame) => frame.intent === null)).toBe(true);
    await act(async () => page.current.review(false));
    const former = page.current;
    await act(async () => {
      void page.current.submit(false);
    });
    await page.replace(second);
    expect(
      page.frames.every((frame) => frame.intent === null && frame.lifecycle?.documentId !== first.documentId),
    ).toBe(true);
    await act(async () => page.current.review(false));
    await act(async () => {
      void page.current.submit(false);
    });
    expect(commands[1]!.intent.address).toEqual(second);
    expect(commands[1]!.intent.binding.csrfToken).toBe('rotated');
    const currentReads = reads;
    await act(async () => {
      commands[0]!.result.resolve({ state: 'acknowledged', receipt: { ...active, complete: true, reason: null } });
    });
    expect(page.current.pending).toBe(true);
    await act(async () => {
      void former.submit(false);
      void page.current.submit(false);
      void page.current.reread();
    });
    expect(commands).toHaveLength(2);
    expect(reads).toBe(currentReads);
    await act(async () => {
      commands[1]!.result.resolve({ state: 'uncertain' });
    });
    expect(page.current.unresolved).toBe(true);
    await act(async () => {
      void page.current.submit(false);
    });
    expect(commands[2]!.intent).toBe(commands[1]!.intent);
    await act(async () => {
      commands[2]!.result.resolve({ state: 'conflict', status: 412 });
    });
    expect(reads).toBe(currentReads + 1);
    expect(page.current.intent).toBeNull();
    expect(page.current.editing).toBe(true);
  } finally {
    await page.close();
  }
});
