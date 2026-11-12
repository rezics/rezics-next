import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { historicalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedInventoryVisit, hostedOwnerBookHref } from '../src/studio/hosted-inventory';
import { createHostedBookNative, hostedFailure } from '../src/studio/hosted-native';
import { openHostedStudio, type HostedStudioInput, type StudioDocumentPort } from '../src/studio/hosted-workspace';
import type {
  HostedBook,
  HostedBookNative,
  HostedOwnedBook,
  HostedOwnerInventory,
} from '../src/studio/hosted-contract';
import type { StudioResult } from '../src/studio/contract';

const accountId = '00000000-0000-8000-8000-000100000001';
const catalogueId = '00000000-0000-8000-8000-000200000001';
const headRevisionId = '00000000-0000-8000-8000-000200000002';
const publicationId = '00000000-0000-8000-8000-000200000003';
const viewer = { accountId, authnEpoch: 7 };
const scope = { kind: 'all-homes', route: 1, crossHome: 'partial' } as const;
const item = {
  catalogueId,
  threadId: '00000000-0000-8000-8000-000200000004',
  createdAt: '2026-11-12T12:34:56.123456Z',
  postRevisionId: '00000000-0000-8000-8000-000200000005',
  postVisibility: 'draft',
  headRevisionId,
  publicationId,
} as const;
const page = (
  items: HostedOwnerInventory['items'] = [item],
  nextCursor: string | null = null,
): HostedOwnerInventory => ({ scope, viewer, items, nextCursor });
const ok = <T>(value: T): StudioResult<T> => ({ ok: true, value });
const signal = () => new AbortController().signal;
function transport(data: unknown, status = 200) {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)));
      return Response.json(data, { status });
    },
  });
  return { native: createHostedBookNative(client), calls };
}
function session() {
  const client = new QueryClient();
  const value = { state: 'signed-in', subject: accountId, csrfToken: 'test-session' };
  client.setQueryData(['session'], value);
  return {
    client,
    source: historicalReaderSource(client),
    replace: () => client.setQueryData(['session'], { ...value }),
  };
}

test('installed native owner list requests all homes and retains native coverage, timestamps and foreign identities', async () => {
  for (const crossHome of ['partial', 'complete'] as const) {
    const response = { ...page(), scope: { ...scope, crossHome } };
    const { native, calls } = transport(response);
    expect(await native.listOwn(accountId, null, signal())).toEqual(ok(response));
    expect(calls[0]!.pathname).toBe(`/v1/accounts/${accountId}/hostedCatalogues`);
    expect(calls[0]!.searchParams.get('scope')).toBe('all-homes');
    expect(calls[0]!.searchParams.get('limit')).toBe('20');
  }
});

test('same-home fallback is only API-reported and its cursor continues with that scope', async () => {
  const response = {
    ...page([], 'native+cursor/='),
    scope: { kind: 'same-home', route: 0, crossHome: 'unavailable' } as const,
  };
  const { native, calls } = transport(response);
  expect(await native.listOwn(accountId, null, signal())).toEqual(ok(response));
  await native.listOwn(accountId, 'native+cursor/=', signal(), response);
  expect(calls[1]!.searchParams.get('scope')).toBe('same-home');
  expect(calls[1]!.searchParams.get('cursor')).toBe('native+cursor/=');
  const broken = transport({ ...response, scope: { ...response.scope, crossHome: 'complete' } });
  expect((await broken.native.listOwn(accountId, null, signal())).ok).toBe(false);
  const unavailable = transport({}, 503);
  expect((await unavailable.native.listOwn(accountId, null, signal())).ok).toBe(false);
  expect(unavailable.calls).toHaveLength(1);
});

test('native continuation fails closed on changed viewer, scope, access or cursor and never falls back', async () => {
  const binding = { scope, viewer };
  for (const response of [
    { ...page(), viewer: { ...viewer, authnEpoch: 8 } },
    { ...page(), viewer: { ...viewer, accountId: catalogueId } },
    { ...page(), scope: { ...scope, route: 2 } },
    { ...page(), scope: { kind: 'same-home', route: 1, crossHome: 'unavailable' } },
  ]) {
    const { native, calls } = transport(response);
    expect((await native.listOwn(accountId, 'exact-cursor', signal(), binding)).ok).toBe(false);
    expect(calls).toHaveLength(1);
  }
  for (const status of [400, 401, 403, 409]) {
    const { native, calls } = transport({}, status);
    expect((await native.listOwn(accountId, 'exact-cursor', signal(), binding)).ok).toBe(false);
    expect(calls[0]!.searchParams.get('cursor')).toBe('exact-cursor');
    expect(calls).toHaveLength(1);
  }
});

test('exact native owner selection retains scope and epoch without deriving its home from the account', async () => {
  const owned: HostedOwnedBook = { scope, viewer, item };
  const { native, calls } = transport(owned);
  expect(await native.readOwn(accountId, catalogueId, signal(), viewer)).toEqual(ok(owned));
  expect(calls[0]!.pathname).toBe(`/v1/accounts/${accountId}/hostedCatalogues/${catalogueId}`);
  expect([...calls[0]!.searchParams]).toEqual([]);
  expect((await native.readOwn(accountId, catalogueId, signal(), { ...viewer, authnEpoch: 6 })).ok).toBe(false);
  const href = new URL(hostedOwnerBookHref(item, viewer), 'https://web.test');
  expect(href.searchParams.get('catalogueId')).toBe(catalogueId);
  expect(href.searchParams.get('ownerAccount')).toBe(accountId);
  expect(href.searchParams.get('ownerEpoch')).toBe('7');
});

test('sparse pages keep their native continuation and retry the exact failed cursor and binding', async () => {
  const identity = session();
  const calls: unknown[] = [];
  let attempt = 0;
  const visit = new HostedInventoryVisit(
    {
      listOwn: async (...args) => {
        calls.push([args[1], args[3]]);
        return ++attempt === 1
          ? ok(page([], 'sparse-boundary'))
          : attempt === 2
            ? hostedFailure('unavailable', 'Retry this page')
            : ok(page([item]));
      },
    },
    identity.source,
    accountId,
  );
  await visit.load();
  expect(visit.snapshot().kind).toBe('ready');
  await visit.next();
  expect(visit.snapshot()).toMatchObject({ kind: 'failed', cursor: 'sparse-boundary' });
  await visit.load();
  expect(visit.snapshot()).toMatchObject({ kind: 'ready', page: { items: [item] } });
  expect(calls).toEqual([
    [null, undefined],
    ['sparse-boundary', { scope, viewer }],
    ['sparse-boundary', { scope, viewer }],
  ]);
  visit.dispose();
  identity.client.clear();
});

test('a repeated native cursor fails closed instead of looping or showing an empty result', async () => {
  const identity = session();
  const visit = new HostedInventoryVisit({ listOwn: async () => ok(page([], 'repeat')) }, identity.source, accountId);
  await visit.load();
  await visit.next();
  expect(visit.snapshot()).toMatchObject({ kind: 'failed', cursor: 'repeat', error: { kind: 'stale' } });
  visit.dispose();
  identity.client.clear();
});

test('same-account browser session replacement aborts an in-flight page and cannot revive its rows', async () => {
  const identity = session();
  let finish!: (result: StudioResult<HostedOwnerInventory>) => void;
  let requestSignal: AbortSignal | undefined;
  const visit = new HostedInventoryVisit(
    {
      listOwn: async (_account, _cursor, request) => {
        requestSignal = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    identity.source,
    accountId,
  );
  const reading = visit.load();
  identity.replace();
  expect(requestSignal!.aborted).toBe(true);
  expect(visit.snapshot()).toEqual({ kind: 'ended' });
  finish(ok(page()));
  await reading;
  expect(visit.snapshot()).toEqual({ kind: 'ended' });
  visit.dispose();
  identity.client.clear();
});

test('changed native viewer retires the inventory and denied continuation removes prior rows', async () => {
  for (const result of [
    ok({ ...page(), viewer: { ...viewer, authnEpoch: 8 } }),
    hostedFailure('denied', 'Access changed'),
  ]) {
    const identity = session();
    let count = 0;
    const visit = new HostedInventoryVisit(
      { listOwn: async () => (++count === 1 ? ok(page([item], 'next')) : result) },
      identity.source,
      accountId,
    );
    await visit.load();
    await visit.next();
    expect(visit.snapshot().kind).toBe(result.ok ? 'ended' : 'failed');
    expect('page' in visit.snapshot()).toBe(false);
    visit.dispose();
    identity.client.clear();
  }
});

const structure: HostedBook = {
  revision: { catalogueId, revisionId: headRevisionId, kind: 'structure', sourceRevisionId: null },
  placements: [],
};
const publication: HostedBook = {
  revision: { catalogueId, revisionId: publicationId, kind: 'publication', sourceRevisionId: headRevisionId },
  placements: [],
};
const documents: StudioDocumentPort = {
  isCurrent: () => true,
  documents: async () => ok({ items: [], nextCursor: null }),
  open: async () => hostedFailure('unavailable', 'No document'),
  createDraft: async () => hostedFailure('unavailable', 'No document'),
  saveDraft: async () => hostedFailure('unavailable', 'No document'),
  versions: async () => ok({ items: [], nextCursor: null }),
  revision: async () => hostedFailure('unavailable', 'No document'),
};
const input: HostedStudioInput = {
  visitKey: 'hosted-test',
  projectId: catalogueId,
  title: 'Book',
  documents: { items: [], nextCursor: null },
  publications: { items: [], nextCursor: null },
  canCreateDraft: false,
};

test('the existing organizer opens exactly the admitted foreign structure and current publication', async () => {
  const owned: HostedOwnedBook = { scope, viewer, item };
  const selections: unknown[] = [];
  const epochs: unknown[] = [];
  const native: HostedBookNative = {
    listHistory: async () => ok({ catalogueId, items: [], nextCursor: null }),
    listOwn: async () => ok(page()),
    readOwn: async (_account, _id, _signal, expected) => {
      epochs.push(expected);
      return ok(owned);
    },
    read: async (selection) => {
      selections.push(selection);
      return ok(selection.kind === 'structure' ? structure : publication);
    },
    create: async () => ok(structure),
    revise: async () => ok(structure),
    publish: async () => ok(publication),
  };
  const options = {
    catalogueId,
    accountId,
    input,
    documents,
    native,
    owner: owned,
    isCurrent: () => true,
    resolveTarget: async () => hostedFailure('unavailable', 'No target'),
  };
  const result = await openHostedStudio(options, signal());
  expect(result.ok).toBe(true);
  expect(selections).toEqual([
    { catalogueId, kind: 'structure', revisionId: headRevisionId },
    { catalogueId, kind: 'publication', revisionId: publicationId },
  ]);
  expect(epochs).toEqual([viewer, viewer]);
  if (result.ok)
    expect(result.value.workspace.input.publications.items[0]).toMatchObject({
      publicationId,
      revision: publicationId,
    });
  let reads = 0;
  const changed = await openHostedStudio(
    {
      ...options,
      native: {
        ...native,
        readOwn: async () => ok(++reads === 1 ? owned : { ...owned, item: { ...item, headRevisionId: publicationId } }),
      },
    },
    signal(),
  );
  expect(changed).toMatchObject({ ok: false, error: { kind: 'stale' } });
  let current = true;
  const ended = await openHostedStudio(
    {
      ...options,
      isCurrent: () => current,
      native: {
        ...native,
        read: async () => {
          current = false;
          return ok(structure);
        },
      },
    },
    signal(),
  );
  expect(ended).toMatchObject({ ok: false, error: { kind: 'denied' } });
});
