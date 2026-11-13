import { expect, test, spyOn } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicationReview, StudioResult } from './contract';
import { StudioController } from './controller';
import type { HostedBook, HostedBookNative, HostedOwnedBook, HostedPublish } from './hosted-contract';
import { openHostedStudio, type StudioDocumentPort } from './hosted-workspace';
import { StudioPublication } from './publication';

const id = (n: number) => `00000000-0000-8000-8000-${n.toString().padStart(12, '0')}`;
const catalogueId = id(1);
const structureId = id(2);
const releaseId = id(3);
const withdrawalId = id(4);
const occurrenceId = id(6);
const exact = { postId: id(7), revisionId: id(8), sha256: 'a'.repeat(64) };
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const failure = (kind: 'unavailable' | 'uncertain' | 'stale' | 'denied'): StudioResult<never> => ({
  ok: false,
  error: { kind, message: `Native ${kind}` },
});
const structure: HostedBook = {
  revision: { catalogueId, revisionId: structureId, kind: 'structure', sourceRevisionId: null },
  placements: [
    {
      occurrenceId,
      parentId: null,
      position: 0,
      title: 'Opening',
      kind: 'chapter',
      target: { ...exact, threadId: id(9) },
    },
  ],
};
const release: HostedBook = {
  ...structure,
  revision: { catalogueId, revisionId: releaseId, kind: 'publication', sourceRevisionId: structureId },
};

async function fixture(visibility: 'draft' | 'published' = 'published', initial: HostedBook | null = release) {
  let current = true;
  let live = initial;
  let visibilityNow = visibility;
  let ownerUnavailable = false;
  let currentUnavailable = false;
  let nullPointer = false;
  let loseReceipt = false;
  let stale = false;
  let beforePublish: (() => Promise<void>) | null = null;
  const commands: { body: HostedPublish; key: string }[] = [];
  const reads: Parameters<HostedBookNative['read']>[0][] = [];
  const receipts = new Map<string, HostedBook>();
  const documents: StudioDocumentPort = {
    isCurrent: () => current,
    documents: async () => ok({ items: [], nextCursor: null }),
    open: async () => failure('unavailable'),
    createDraft: async () => failure('unavailable'),
    saveDraft: async () => failure('unavailable'),
    versions: async () => ok({ items: [], nextCursor: null }),
    revision: async () => failure('unavailable'),
  };
  const owned = (): HostedOwnedBook => ({
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    viewer: { accountId: catalogueId, authnEpoch: 1 },
    item: {
      catalogueId,
      threadId: id(9),
      createdAt: '2026-01-01T00:00:00Z',
      postRevisionId: id(10),
      postVisibility: visibilityNow,
      headRevisionId: structureId,
      publicationId: nullPointer ? null : (live?.revision.revisionId ?? null),
    },
  });
  const native: HostedBookNative = {
    listHistory: async () => ok({ catalogueId, items: [], nextCursor: null }),
    listOwn: async () => ok({ ...owned(), items: [], nextCursor: null }),
    readOwn: async () => (ownerUnavailable ? failure('unavailable') : ok(owned())),
    read: async (selection) => {
      reads.push(selection);
      if (selection.kind === 'structure') return ok(structure);
      if (!selection.revisionId && currentUnavailable) return failure('unavailable');
      if (selection.revisionId === releaseId) return ok(release);
      return live ? ok(live) : failure('unavailable');
    },
    create: async () => failure('unavailable'),
    revise: async () => failure('unavailable'),
    publish: async (_catalogueId, body, key) => {
      commands.push({ body: structuredClone(body), key });
      if (beforePublish) await beforePublish();
      if (stale) return failure('stale');
      let result = receipts.get(key);
      if (!result) {
        result = {
          revision: {
            catalogueId,
            revisionId: body.occurrenceIds.length ? id(5) : withdrawalId,
            kind: 'publication',
            sourceRevisionId: structureId,
          },
          placements: body.occurrenceIds.length ? structure.placements : [],
        };
        receipts.set(key, result);
        live = result;
      }
      return loseReceipt ? failure('uncertain') : ok(result);
    },
  };
  const signal = new AbortController().signal;
  const opened = await openHostedStudio(
    {
      catalogueId,
      accountId: catalogueId,
      native,
      admitPublicRelease: async () => true,
      documents,
      isCurrent: () => current,
      resolveTarget: async () => failure('unavailable'),
      input: {
        visitKey: 'withdrawal-test',
        projectId: catalogueId,
        title: 'Book',
        documents: { items: [], nextCursor: null },
        publications: { items: [], nextCursor: null },
        canCreateDraft: true,
      },
    },
    signal,
  );
  if (!opened.ok) throw new Error(opened.error.message);
  const { input, port, bookPort } = opened.value.workspace;
  const controller = new StudioController(input, port, bookPort);
  const disconnect = controller.connect();
  return {
    controller,
    port,
    book: opened.value.book,
    commands,
    reads,
    signal,
    disconnect,
    end: () => {
      current = false;
    },
    visibility: (value: typeof visibility) => {
      visibilityNow = value;
    },
    ownerUnavailable: (value: boolean) => {
      ownerUnavailable = value;
    },
    currentUnavailable: (value: boolean) => {
      currentUnavailable = value;
    },
    nullPointer: (value: boolean) => {
      nullPointer = value;
    },
    loseReceipt: (value: boolean) => {
      loseReceipt = value;
    },
    stale: () => {
      stale = true;
    },
    beforePublish: (run: () => Promise<void>) => {
      beforePublish = run;
    },
  };
}

function markup(controller: StudioController) {
  return renderToStaticMarkup(createElement(StudioPublication, { controller, state: controller.snapshot() }));
}

test('explicit Book withdrawal reviews the exact release, confirms current removal, preserves drafts and allows republish', async () => {
  const f = await fixture();
  expect(markup(f.controller)).toContain('Review Book withdrawal');
  await f.controller.reviewWithdrawal();
  const review = f.controller.snapshot().review!;
  expect(review.withdrawal).toEqual({ publicationId: releaseId, revision: releaseId });
  const html = markup(f.controller);
  expect(html).toContain(`Current release: ${releaseId}`);
  expect(html).toContain('removes this Book from current discovery');
  expect(html).toContain('drafts and table of contents remain');
  expect(html).toContain('existing access rules');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Withdraw reviewed Book/);
  expect(await f.controller.publish()).toBe(true);
  expect(f.commands[0]?.body).toEqual({
    expectedRevisionId: structureId,
    expectedPublicationId: releaseId,
    occurrenceIds: [],
  });
  expect(f.reads.at(-1)).toEqual({ catalogueId, kind: 'publication' });
  expect(f.controller.snapshot().published?.state).toBe('withdrawn');
  expect(f.controller.snapshot().structure?.placements).toHaveLength(1);
  expect(f.controller.canWithdrawBook()).toBe(false);
  expect(markup(f.controller)).toContain(`Withdrawal release ${withdrawalId} confirmed`);
  f.controller.toggleOccurrence(occurrenceId, true);
  await f.controller.reviewPublication();
  expect(f.controller.snapshot().review?.withdrawal).toBeUndefined();
  expect(await f.controller.publish()).toBe(true);
  expect(f.commands[1]?.body).toEqual({
    expectedRevisionId: structureId,
    expectedPublicationId: withdrawalId,
    occurrenceIds: [occurrenceId],
  });
  expect(f.controller.canWithdrawBook()).toBe(true);
  f.disconnect();
});

test('ordinary empty publication cannot withdraw; never-published, withdrawn and draft Books have no withdrawal action', async () => {
  const f = await fixture();
  await f.controller.reviewPublication();
  expect(f.controller.snapshot().review).toBeNull();
  await f.controller.reviewWithdrawal();
  const { withdrawal: _, ...review } = f.controller.snapshot().review!;
  expect(
    (await f.port.publish({ projectId: catalogueId, review, idempotencyKey: crypto.randomUUID() }, f.signal)).ok,
  ).toBe(false);
  expect(
    (
      await f.book.publish(
        {
          target: review.target as Extract<PublicationReview['target'], { kind: 'book' }>,
          expectedPublicationId: releaseId,
          idempotencyKey: crypto.randomUUID(),
        },
        f.signal,
      )
    ).ok,
  ).toBe(false);
  expect(f.commands).toHaveLength(0);
  f.disconnect();
  const withdrawn = { ...release, placements: [] };
  for (const [visibility, release] of [
    ['published', null],
    ['published', withdrawn],
    ['draft', undefined],
  ] as const) {
    const visit = await fixture(visibility, release);
    expect(visit.controller.canWithdrawBook()).toBe(false);
    expect(markup(visit.controller)).not.toContain('Review Book withdrawal');
    await visit.controller.reviewWithdrawal();
    expect(visit.controller.snapshot().review).toBeNull();
    expect(visit.commands).toHaveLength(0);
    visit.disconnect();
  }
});

test('withdrawal rechecks published admission and stale CAS uses existing review recovery', async () => {
  const f = await fixture();
  f.visibility('draft');
  await f.controller.reviewWithdrawal();
  expect(f.controller.snapshot().issue?.kind).toBe('stale');
  expect(f.controller.snapshot().review).toBeNull();
  f.visibility('published');
  await f.controller.reviewWithdrawal();
  f.stale();
  expect(await f.controller.publish()).toBe(false);
  expect(f.controller.snapshot().issue?.kind).toBe('stale');
  expect(f.controller.snapshot().review).toBeNull();
  expect(f.controller.hasUnresolvedCommand()).toBe(false);
  expect(f.controller.snapshot().published).toBeNull();
  f.disconnect();
});

test('missing owner pointer, failed current read and lost receipt remain uncertain and retry the original command after review expiry', async () => {
  for (const mode of ['pointer', 'current', 'receipt', 'owner'] as const) {
    const f = await fixture();
    await f.controller.reviewWithdrawal();
    const review = f.controller.snapshot().review!;
    if (mode === 'pointer') f.nullPointer(true);
    if (mode === 'current') f.currentUnavailable(true);
    if (mode === 'receipt') f.loseReceipt(true);
    if (mode === 'owner') f.ownerUnavailable(true);
    expect(await f.controller.publish()).toBe(false);
    expect(f.controller.snapshot().published).toBeNull();
    expect(f.controller.snapshot().issue?.kind).toBe('uncertain');
    expect(f.controller.hasUnresolvedCommand()).toBe(true);
    f.nullPointer(false);
    f.currentUnavailable(false);
    f.loseReceipt(false);
    f.ownerUnavailable(false);
    const clock = spyOn(Date, 'now').mockReturnValue(Date.parse(review.expiresAt) + 1);
    try {
      expect(await f.controller.retry()).toBe(true);
      expect(f.commands).toHaveLength(2);
      expect(f.commands[1]).toEqual(f.commands[0]);
      expect(f.controller.snapshot().published?.revision).toBe(withdrawalId);
    } finally {
      clock.mockRestore();
      f.disconnect();
    }
  }
});

test('session replacement during withdrawal discards late acknowledgement', async () => {
  const f = await fixture();
  await f.controller.reviewWithdrawal();
  let finish!: () => void;
  f.beforePublish(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const publishing = f.controller.publish();
  f.end();
  finish();
  expect(await publishing).toBe(false);
  expect(f.controller.snapshot().published).toBeNull();
  expect(f.controller.snapshot().currentBookPublication?.revision).toBe(releaseId);
  f.disconnect();
});
