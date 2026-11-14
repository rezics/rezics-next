import { expect, mock, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { editionDocumentDigest } from '../content-editions/edition-model';
import type { StudioPage, StudioPort, StudioRevision, StudioRevisionHeader } from './contract';
import { StudioController } from './controller';

async function fixture() {
  const body = fromPlainText('Current saved draft', 'blocks');
  const revision: StudioRevision = {
    exact: { postId: 'post', revisionId: 'saved', sha256: await editionDocumentDigest(body) },
    title: 'Saved title',
    body,
    savedAt: '2026-11-14T00:00:00.123456Z',
    mediaIds: [],
  };
  const header = { exact: revision.exact, savedAt: revision.savedAt };
  const requests: unknown[] = [];
  let fail = false;
  let current = true;
  let response: StudioPage<StudioRevisionHeader> = { items: [header], nextCursor: 'opaque:1+/=' };
  const unused = mock(async (): Promise<never> => {
    throw new Error('Unexpected version browsing operation');
  });
  const port: StudioPort = {
    isCurrent: () => current,
    open: mock(async () => ({ ok: true, value: { revision, permissions: { edit: true, publish: false } } })),
    documents: unused,
    createDraft: unused,
    saveDraft: unused,
    reviewPublication: unused,
    publish: unused,
    publications: unused,
    versions: mock(async (input) => {
      requests.push(input);
      return fail
        ? { ok: false as const, error: { kind: 'unavailable' as const, message: 'Unavailable' } }
        : { ok: true as const, value: response };
    }),
    revision: mock(async () => ({ ok: true, value: revision })),
  };
  const controller = new StudioController(
    {
      visitKey: 'versions',
      projectId: 'project',
      title: 'Column',
      profile: { kind: 'articles', seriesTitle: null },
      initialSelection: { revision, permissions: { edit: true, publish: false } },
      documents: { items: [], nextCursor: null },
      publications: { items: [], nextCursor: null },
      canCreateDraft: false,
      canPublish: false,
    },
    port,
  );
  const disconnect = controller.connect();
  return {
    controller,
    port,
    revision,
    disconnect,
    requests,
    fail: (value: boolean) => {
      fail = value;
    },
    respond: (value: StudioPage<StudioRevisionHeader>) => {
      response = value;
    },
    retire: () => {
      current = false;
    },
  };
}

test('sparse Next, failed Previous and retry preserve the admitted page and exact cursor', async () => {
  const f = await fixture();
  try {
    await f.controller.loadVersions();
    f.respond({ items: [], nextCursor: 'opaque:2?+/=' });
    await f.controller.loadVersions(true);
    f.respond({ items: [], nextCursor: 'opaque:3?+/=' });
    await f.controller.loadVersions(true);
    const admitted = f.controller.snapshot();
    expect(admitted.versionNavigation).toEqual({
      admitted: true,
      cursor: 'opaque:2?+/=',
      predecessors: [null, 'opaque:1+/='],
      staged: null,
    });
    f.fail(true);
    expect(await f.controller.navigateVersions('previous')).toBe(false);
    expect(f.controller.snapshot().versions).toBe(admitted.versions);
    expect(f.controller.snapshot().versionNavigation).toEqual({
      ...admitted.versionNavigation,
      staged: { cursor: 'opaque:1+/=', movement: 'previous' },
    });
    expect(await f.controller.navigateVersions('retry')).toBe(false);
    expect(f.port.versions).toHaveBeenLastCalledWith(
      { projectId: 'project', postId: 'post', cursor: 'opaque:1+/=' },
      expect.any(AbortSignal),
    );
    f.fail(false);
    f.respond({ items: [], nextCursor: 'opaque:2?+/=' });
    await f.controller.navigateVersions('retry');
    expect(f.controller.snapshot().versionNavigation.predecessors).toEqual([null]);
    // Empty pages do not prevent following their native continuation.
    await f.controller.loadVersions(true);
    expect(f.port.versions).toHaveBeenLastCalledWith(
      { projectId: 'project', postId: 'post', cursor: 'opaque:2?+/=' },
      expect.any(AbortSignal),
    );
    expect(f.port.revision).not.toHaveBeenCalled();
  } finally {
    f.disconnect();
  }
});

test('only eight predecessor cursors are retained; Previous rereads and explicit First restarts', async () => {
  const f = await fixture();
  try {
    await f.controller.loadVersions();
    for (let index = 1; index <= 11; index++) {
      f.respond({ items: [], nextCursor: `page:${index + 1}` });
      await f.controller.loadVersions(true);
    }
    expect(f.controller.snapshot().versionNavigation.predecessors).toHaveLength(8);
    for (let index = 0; index < 8; index++) await f.controller.navigateVersions('previous');
    expect(f.controller.snapshot().versionNavigation.predecessors).toEqual([]);
    const calls = f.requests.length;
    expect(await f.controller.navigateVersions('previous')).toBe(false);
    expect(f.port.versions).toHaveBeenCalledTimes(calls);
    f.fail(true);
    await f.controller.navigateVersions('first');
    expect(f.controller.snapshot().versionNavigation.cursor).not.toBeNull();
    f.fail(false);
    await f.controller.navigateVersions('retry');
    expect(f.controller.snapshot().versionNavigation).toEqual({
      admitted: true,
      cursor: null,
      predecessors: [],
      staged: null,
    });
  } finally {
    f.disconnect();
  }
});

test('a failed first address remains retryable; document and visit replacement retire history', async () => {
  const f = await fixture();
  try {
    f.fail(true);
    await f.controller.loadVersions();
    expect(f.controller.snapshot().versionNavigation).toEqual({
      admitted: false,
      cursor: null,
      predecessors: [],
      staged: { cursor: null, movement: 'first' },
    });
    f.fail(false);
    await f.controller.navigateVersions('retry');
    await f.controller.loadVersions(true);
    await f.controller.inspectVersion(f.revision.exact);
    await f.controller.open('post');
    expect(f.controller.snapshot().historical).toBeNull();
    expect(f.controller.snapshot().versions).toBeNull();
    expect(f.controller.snapshot().versionNavigation.predecessors).toEqual([]);
    await f.controller.loadVersions();
    f.retire();
    expect(await f.controller.navigateVersions('next')).toBe(false);
  } finally {
    f.disconnect();
  }
  expect(f.controller.snapshot().versions).toBeNull();
  expect(f.controller.snapshot().versionNavigation.staged).toBeNull();
});
