import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import type {
  StudioPort,
  StudioResult,
  StudioPage,
  StudioRevisionHeader,
  StudioRevision,
} from '../src/studio/contract';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { fromMarkdown, fromPlainText } = await import('@rezics/document');
const { editionDocumentDigest } = await import('../src/content-editions/edition-model');
const { StudioController } = await import('../src/studio/controller');
const { StudioVersions } = await import('../src/studio/revisions');
const { setLocale } = await import('../src/paraglide/runtime.js');
afterAll(async () => {
  setLocale('en', { reload: false });
  await dom.restore();
});
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });

async function fixture() {
  setLocale('en', { reload: false });
  const revision = async (id: string): Promise<StudioRevision> => {
    const body = fromMarkdown(
      '## Shared heading\n\nSaved **structured** text.\n\nThe ending is >!a secret!<.\n\n```ts\nconst saved = true;\n```',
      'blocks',
    );
    return {
      exact: { postId: 'post', revisionId: id, sha256: await editionDocumentDigest(body) },
      title: id,
      body,
      savedAt: '2026-11-14T12:00:00.123456Z',
      mediaIds: [],
    };
  };
  const current = await revision('Current');
  const older = await revision('Older');
  const oldest = await revision('Oldest');
  const unused = mock(async (): Promise<never> => {
    throw new Error('No save or publication during browsing');
  });
  const port: StudioPort = {
    isCurrent: () => true,
    documents: unused,
    open: unused,
    createDraft: unused,
    saveDraft: unused,
    publications: unused,
    publish: unused,
    reviewPublication: unused,
    versions: mock(async () =>
      ok({
        items: [older, oldest].map(({ exact, savedAt }) => ({ exact, savedAt })),
        nextCursor: 'opaque+/=',
      }),
    ),
    revision: mock(async ({ document }) => ok(document.revisionId === oldest.exact.revisionId ? oldest : older)),
  };
  const controller = new StudioController(
    {
      visitKey: 'browsing',
      projectId: 'project',
      title: 'Column',
      profile: { kind: 'articles', seriesTitle: null },
      initialSelection: { revision: current, permissions: { edit: true, publish: true } },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: true,
    },
    port,
  );
  const disconnect = controller.connect();
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  function View({ hidden = false }: { hidden?: boolean }) {
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
    return (
      <div hidden={hidden}>
        <StudioVersions controller={controller} state={state} presentation={{}} />
      </div>
    );
  }
  await act(async () => {
    await controller.loadVersions();
    await controller.inspectVersion(older.exact);
    root.render(<View />);
  });
  return {
    controller,
    port,
    host,
    root,
    View,
    older,
    oldest,
    current,
    dispose: async () => {
      await act(async () => root.unmount());
      disconnect();
      host.remove();
    },
  };
}

test('exact comparison readers own independent IDs/disclosures; stale copy review never replaces new working text', async () => {
  const f = await fixture();
  try {
    const readers = [...f.host.querySelectorAll('[data-slot="post-reading-body"]')];
    expect(readers).toHaveLength(2);
    const headingIds = readers.map(
      (reader) => getByRole(reader as HTMLElement, 'heading', { name: 'Shared heading' }).id,
    );
    expect(headingIds.every(Boolean)).toBe(true);
    expect(new Set(headingIds).size).toBe(2);
    const reveal = getByRole(readers[0] as HTMLElement, 'button', { name: 'Reveal spoiler' });
    await act(async () => reveal.click());
    expect(queryByRole(readers[0] as HTMLElement, 'button', { name: 'Reveal spoiler' })).toBeNull();
    expect(getByRole(readers[1] as HTMLElement, 'button', { name: 'Reveal spoiler' })).toBeTruthy();
    await act(async () => f.root.render(<f.View hidden />));
    await act(async () => f.root.render(<f.View />));
    expect(f.host.querySelector('[data-slot="post-reading-body"]')).toBe(readers[0]);
    expect(queryByRole(readers[0] as HTMLElement, 'button', { name: 'Reveal spoiler' })).toBeNull();
    await act(async () => getByRole(readers[1] as HTMLElement, 'button', { name: 'Reveal spoiler' }).click());
    const address = f.controller.snapshot().versionNavigation;
    await act(async () => f.controller.reviewVersionCopy());
    const oldReview = f.controller.snapshot().versionCopyReview;
    const working = fromPlainText('Unsaved text remains in the editor.', 'blocks');
    await act(async () => f.controller.changeBody(working));
    expect(f.host.textContent).toContain('Review this copy again');
    expect(queryByRole(f.host, 'button', { name: 'Copy into working draft' })).toBeNull();
    expect(f.controller.restoreVersion(oldReview)).toBe(false);
    expect(f.controller.snapshot().selected?.body).toBe(working);
    expect(f.host.textContent).not.toContain('Unsaved text remains in the editor.');
    await act(async () => f.controller.reviewVersionCopy());
    const olderReview = f.controller.snapshot().versionCopyReview;
    await act(async () => {
      await f.controller.inspectVersion(f.oldest.exact);
    });
    expect(f.controller.restoreVersion(olderReview)).toBe(false);
    expect(f.host.querySelectorAll('[data-slot="post-reading-body"]')[1]).toBe(readers[1]);
    expect(queryByRole(readers[1] as HTMLElement, 'button', { name: 'Reveal spoiler' })).toBeNull();
    expect(f.host.textContent).toContain('“Oldest”');
    await act(async () => f.controller.reviewVersionCopy());
    await act(async () => getByRole(f.host, 'button', { name: 'Copy into working draft' }).click());
    expect(f.controller.snapshot().selected?.body).toBe(f.oldest.body);
    expect(f.controller.snapshot().selected?.source.revision).toBe(f.current);
    expect(f.controller.snapshot().versionNavigation).toBe(address);
    expect(f.port.saveDraft).not.toHaveBeenCalled();
    expect(f.port.publish).not.toHaveBeenCalled();
    const page = f.controller.snapshot().versions;
    f.port.saveDraft = async (input) =>
      ok({
        revision: {
          ...f.current,
          title: input.title,
          body: input.body,
          exact: { postId: 'post', revisionId: 'Saved-copy', sha256: await editionDocumentDigest(input.body) },
        },
        permissions: { edit: true, publish: true },
      });
    await act(async () => {
      await f.controller.save();
    });
    expect(f.controller.snapshot().selected?.dirty).toBe(false);
    expect(f.controller.snapshot().versionNavigation).toBe(address);
    expect(f.controller.snapshot().versions).toBe(page);
    expect(f.controller.snapshot().historical).toBe(f.oldest);
  } finally {
    await f.dispose();
  }
});

test('keyboard page movement orients locally; focus moved elsewhere and hidden tabs cancel late orientation', async () => {
  const f = await fixture();
  const elsewhere = document.body.appendChild(document.createElement('button'));
  const inspection = spyOn(f.controller, 'inspectVersion');
  try {
    await act(async () => {
      const compare = f.host.querySelector<HTMLButtonElement>('.studio-version-list button')!;
      compare.focus();
      compare.click();
      await inspection.mock.results.at(-1)?.value;
    });
    expect(document.activeElement).toBe(getByRole(f.host, 'heading', { name: 'Selected version', exact: true }));
    let resolve!: (value: StudioResult<StudioPage<StudioRevisionHeader>>) => void;
    f.port.versions = () =>
      new Promise((done) => {
        resolve = done;
      });
    const next = () => getByRole(f.host, 'button', { name: 'Next versions page' }) as HTMLButtonElement;
    const request = async () =>
      act(async () => {
        next().focus();
        next().click();
      });
    const finish = async () =>
      act(async () => {
        resolve(ok({ items: [], nextCursor: 'next' }));
      });
    await request();
    await finish();
    expect(document.activeElement).toBe(getByRole(f.host, 'heading', { name: 'Versions', exact: true }));
    await request();
    elsewhere.focus();
    await finish();
    expect(document.activeElement).toBe(elsewhere);
    await request();
    await act(async () => f.root.render(<f.View hidden />));
    await finish();
    expect(document.activeElement).not.toBe(f.host.querySelector('h2'));
    await act(async () => f.root.render(<f.View />));
    expect(f.controller.snapshot().versionNavigation.cursor).toBe('next');
  } finally {
    inspection.mockRestore();
    elsewhere.remove();
    await f.dispose();
  }
});

test('locale and admission replacement retire bodies, consent and coordinates and discard a late page', async () => {
  const f = await fixture();
  try {
    await act(async () => f.controller.reviewVersionCopy());
    let finish!: (value: StudioResult<StudioPage<StudioRevisionHeader>>) => void;
    let signal!: AbortSignal;
    f.port.versions = (_input, requestSignal) => {
      signal = requestSignal;
      return new Promise((done) => {
        finish = done;
      });
    };
    let request!: Promise<boolean>;
    await act(async () => {
      request = f.controller.loadVersions(true);
    });
    await act(async () => {
      setLocale('fr', { reload: false });
      f.root.render(<f.View />);
    });
    expect(signal.aborted).toBe(true);
    expect(f.controller.snapshot().versions).toBeNull();
    expect(f.controller.snapshot().historical).toBeNull();
    expect(f.controller.snapshot().inspectedVersion).toBeNull();
    expect(f.controller.snapshot().versionCopyReview).toBeNull();
    expect(f.controller.snapshot().versionNavigation.predecessors).toEqual([]);
    await act(async () => {
      finish(ok({ items: [{ exact: f.older.exact, savedAt: f.older.savedAt }], nextCursor: 'late' }));
      await request;
    });
    expect(f.host.querySelector('[data-slot="post-reading-body"]')).toBeNull();
    expect(f.controller.snapshot().versions).toBeNull();
    f.port.isCurrent = () => false;
    await act(async () => f.root.render(<f.View />));
    expect(f.host.textContent).toBe('');
    expect(f.controller.snapshot().selected?.source.revision).toBe(f.current);
  } finally {
    await f.dispose();
  }
});
