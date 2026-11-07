import { expect, test } from 'bun:test';
import { composeContentApplication, composeContentFeed } from '../../src/composition/content.ts';
import {
  bindFeedCapabilities,
  createNativeFeedPorts,
  tryFeedCapabilities,
  unbindContentApplication,
  unbindFeedCapabilities,
  type FeedDependencies,
  type FeedNativeSuppliers,
  type FeedProducerCapabilities,
} from '../../src/content/adapters/index.ts';
import { bindContentApplication, tryContentApplication } from '../../src/content/adapters/bind.ts';
import { AuthenticationError } from '../../src/access/contract/authentication.ts';
import { createFeedReads } from '../../src/content/feed.ts';
import { SubjectSummarySchema } from '../../src/semantic/contract/index.ts';
import { SubjectSummarySchema as transportSummary } from '../../src/semantic/adapters/public-summary-schema.ts';

// Construction must not acquire a connection, WorkClient, or an Access capability.
const dependencies = {
  pool: {},
  routeKey: new Uint8Array(16),
  tokens: {},
  clock: () => new Date('2026-01-01T00:00:00.000Z'),
  deadlineNow: () => 0,
  access: {},
  contentAccess: {},
  workClient: () => {
    throw new Error('Unexpected WorkClient acquisition');
  },
  viewerPersonalActions: {},
} as unknown as FeedDependencies;

function restore(previous: ReturnType<typeof tryContentApplication>, feed: ReturnType<typeof tryFeedCapabilities>) {
  unbindContentApplication();
  if (previous) bindContentApplication(previous);
  if (feed) bindFeedCapabilities(feed);
}

test('default composition installs and retains real suppliers once before IO', async () => {
  const previous = tryContentApplication();
  const feed = tryFeedCapabilities();
  try {
    unbindContentApplication();
    expect(tryFeedCapabilities()).toBeUndefined();
    composeContentApplication();
    const bound = tryFeedCapabilities()!;
    composeContentApplication();
    expect(tryFeedCapabilities()).toBe(bound);
    expect(composeContentFeed()).toBe(bound);
    const suppliers = bound.create(dependencies, {} as Parameters<typeof bound.create>[1]);
    expect(suppliers.publicSummary.read).toBeFunction();
    expect(suppliers.readCollection).toBeFunction();
    expect(suppliers.readPublication).toBeFunction();
    expect(suppliers.readAccounts).toBeFunction();
    expect(suppliers.checkCurrentFollowSupport).toBeFunction();
    expect(suppliers.admit).toBeFunction();
    const row = { subjectId: 'x', state: null, lastActivityAt: 't', activeProgressSession: null };
    expect(suppliers.present(row)).toBe(row);
    await expect(
      suppliers.continuation.list({ kind: 'anonymous' }, { limit: 6, view: 'FULL' }, 1, []),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(transportSummary).toBe(SubjectSummarySchema);
  } finally {
    restore(previous, feed);
  }
});

test('native ports retain one supplied producer set and forward live operands unchanged', async () => {
  const previous = tryFeedCapabilities();
  const actor = {
    kind: 'account' as const,
    accountId: '00000000-0000-4000-8000-000000000001',
    scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    authnEpoch: 7,
    clientId: 'web',
    requestedBy: null,
  };
  const calls: unknown[] = [];
  const page = { subjects: [], next: 'owner-next' };
  const summaries = new Map();
  let created = 0;
  const suppliers: FeedNativeSuppliers = {
    continuation: {
      list: async (...args: unknown[]) => {
        calls.push(args);
        return page;
      },
    },
    publicSummary: {
      read: async (...args: unknown[]) => {
        calls.push(args);
        return summaries;
      },
    },
    present: (row) => row,
    checkCurrentFollowSupport: async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
    admit: async (...args: unknown[]) => {
      calls.push(args);
    },
    readCollection: async () => {
      throw new Error('Unexpected Collection read');
    },
    readPublication: async () => {
      throw new Error('Unexpected publication read');
    },
    readAccounts: async () => {
      throw new Error('Unexpected Account read');
    },
  };
  const capabilities: FeedProducerCapabilities = {
    create: () => {
      created++;
      return suppliers;
    },
    isDeadline: () => false,
    isAdmissionFailure: () => false,
  };
  try {
    bindFeedCapabilities(capabilities);
    createFeedReads(dependencies);
    expect(created).toBe(1);
    const ports = createNativeFeedPorts(dependencies, () => actor, capabilities);
    expect(created).toBe(2);
    bindFeedCapabilities({
      ...capabilities,
      create: () => {
        throw new Error('Replaced producer');
      },
    });
    const query = { limit: 6, view: 'FULL' as const, cursor: 'owner', spaceId: 'space', kind: 'schema:Book' };
    const languages = ['zh-Hant', 'en'];
    expect(await ports.continuation!.page(actor, query, 123, languages)).toBe(page);
    expect(await ports.publicSummary!.read(actor, ['one', 'one'], languages, 123)).toBe(summaries);
    await ports.admission.following(actor, 123);
    await ports.admission.personalLibrary(actor, 123);
    await ports.admission.readingProgress(actor, 123);
    await ports.admission.discovery(actor, 123);
    expect(calls).toEqual([
      [actor, query, 123, languages],
      [actor, { ids: ['one', 'one'], languages, deadline: 123 }],
      [actor, { targets: [] }, 123],
      [actor, 'personal_library', 'follow:list', 123],
      [actor, 'personal_library', 'library_entry:list', 123],
      [actor, 'reading_progress', 'progress_session:list', 123],
      [actor, 'search', 'subject:search', 123],
    ]);
    expect(created).toBe(2);
  } finally {
    if (previous) bindFeedCapabilities(previous);
    else unbindFeedCapabilities();
  }
});
