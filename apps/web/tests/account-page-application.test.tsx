import { afterAll, expect, mock, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import * as start from '../.storybook/react-start';
import type { SubjectPageData } from '../src/features/pages/page-model';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type {
  AccountProfilePort,
  ContributionControlsInput,
  ContributionListInput,
  CollectionControlsInput,
} from '../src/features/pages/account-profile-port';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
afterAll(() => mock.restore());

const { AccountPageApplication, AccountList, accountCollectionWindowReading } =
  await import('../src/features/pages/account-page-application');
const { OverviewContext } = await import('../src/features/pages/overview-context');
const { accountOf } = await import('../src/features/pages/account-read');
const { pageContext } = await import('../src/features/pages/page-model');
const accountId = '00000000-0000-4000-8000-000000000001';
const cursor = 'native+/=cursor&selection';

function page(collections = false): SubjectPageData {
  return {
    subject: null,
    account: { id: accountId, handle: 'reader' },
    profile: 'profile',
    template: { scope: 'type', key: 'schema:Person' },
    document: {
      root: { props: {} },
      content: [
        { type: 'AccountIdentity', props: { id: 'identity' } },
        { type: collections ? 'AccountCollections' : 'AccountPosts', props: { id: 'list', limit: 20, paged: true } },
      ],
    },
    reads: {
      r0: {
        status: 200,
        body: {
          accounts: [
            {
              id: accountId,
              state: 'active',
              kind: 'actor',
              handle: 'reader',
              displayName: 'Reader',
              publicViews: { posts: true, reviews: true, collections: true, realms: false },
            },
          ],
        },
      },
      r1: { status: 200, body: { [collections ? 'collections' : 'posts']: [], next: null } },
    },
  };
}

test('collection planning distinguishes an absent response from a withheld profile and preserves publication identity', () => {
  const first = page(true);
  const reading = accountCollectionWindowReading(first);
  expect(reading).toMatchObject({ accountId, published: true, admitted: true, denied: false });
  expect(accountCollectionWindowReading(structuredClone(first))).toEqual(reading);
  expect(accountCollectionWindowReading(undefined)).toBeUndefined();
  expect(accountCollectionWindowReading({ ...first, account: { id: 'another-account', handle: 'other' } })).toBeNull();
  const denied = { ...first, reads: { ...first.reads, r1: { status: 403, body: {} } } };
  expect(accountCollectionWindowReading(denied)).toMatchObject({ admitted: false, denied: true });
  const changed = structuredClone(first);
  (changed.reads.r0!.body as { accounts: { displayName: string }[] }).accounts[0]!.displayName = 'New reading';
  expect(accountCollectionWindowReading(changed)?.publication).not.toBe(reading?.publication);
});

function renderWindow(input: { page: SubjectPageData; section?: Section; hidden?: boolean; collections?: boolean }) {
  const lists: ContributionListInput[] = [];
  const controls: ContributionControlsInput[] = [];
  const collections: CollectionControlsInput[] = [];
  const retire = mock(() => {});
  const native = input.page.reads.r1!;
  const read = planReads(platformRegistry, input.page.document as CompositionDocument, pageContext(input.page)).reads
    .r1!;
  const profile = accountOf(input.page.reads.r0!.body)!;
  if (input.hidden) profile.publicViews.posts = false;
  const value = {
    locale: 'en',
    subject: null,
    account: input.page.account,
    agentBase: '/en/@reader',
    profile,
    sections: new Map([['list', input.section ?? { ok: true, read, body: native.body }]]),
  } as unknown as OverviewValue;
  const binding: AccountProfilePort = {
    useCollectionWindow: () => input.collections === true,
    useContributionPage: () => ({ page: input.page, cursor, view: input.collections ? 'collections' : 'posts' }),
    useContributionRoute: () => !input.collections,
    retireContributionWindow: retire,
    CollectionControls: (props) => {
      collections.push(props);
      return <nav aria-label="Collections" data-next={props.next} />;
    },
    ContributionControls: (props) => {
      controls.push(props);
      return props.failure === 'denied' ? null : <nav aria-label={props.title} data-next={props.next} />;
    },
    ContributionList: (props) => {
      lists.push(props);
      return <>{props.children}</>;
    },
  };
  const html = renderToString(
    <AccountPageApplication profile={binding}>
      <OverviewContext.Provider value={value}>
        <AccountList
          props={{ id: 'list', paged: true, limit: 20 }}
          spec={{
            slot: input.collections ? 'account-collections' : 'account-posts',
            view: input.collections ? 'collections' : 'posts',
            kind: input.collections ? 'accountCollections' : 'accountPosts',
            title: () => (input.collections ? 'Collections' : 'Posts'),
            items: (body) => (input.collections ? body.collections : body.posts),
            row: (row, _value, index) => <li key={index}>{String(row.title)}</li>,
            failure: (state) => <p role="status">{state}</p>,
          }}
        />
      </OverviewContext.Provider>
    </AccountPageApplication>,
  );
  return { html, lists, controls, collections, retire, read };
}

test('installed contribution capabilities receive the original receipt inputs and exact native continuation', () => {
  const source = page();
  const row = { id: 'post', title: 'Public contribution' };
  const selection = { opaque: 'native-action-selection' };
  const body = { posts: [row], next: cursor, actionSelection: selection };
  source.reads.r1 = { status: 200, body };
  const result = renderWindow({ page: source });
  expect(result.html).toContain('Public contribution');
  expect(result.lists).toHaveLength(1);
  const request = result.lists[0]!;
  expect(request.page).toBe(source);
  expect(request.read).toBe(result.read);
  expect(request.source).toBe(body);
  expect(request.selection).toBe(selection);
  expect(request.publication).toBe((source.reads.r0!.body as { accounts: object[] }).accounts[0]!);
  expect(request.rows).toEqual([row]);
  expect(request.rows[0]).toBe(row);
  expect(request.cursor).toBe(cursor);
  expect(result.controls).toMatchObject([
    { owner: { accountId, view: 'posts', published: true }, next: cursor, outcome: 'admitted' },
  ]);
});

test('empty final windows retain installed controls and native failures keep their recovery outcomes', () => {
  const source = page();
  const empty = renderWindow({ page: source });
  expect(empty.html).toContain('account-posts');
  expect(empty.controls).toMatchObject([{ next: null, outcome: 'admitted' }]);
  expect(empty.lists).toHaveLength(0);
  for (const [status, failure] of [
    [400, 'invalid-cursor'],
    [401, 'denied'],
    [403, 'denied'],
    [202, 'preparing'],
    [503, 'unavailable'],
  ] as const) {
    const failed = renderWindow({ page: source, section: { ok: false, status } });
    expect(failed.html).toContain(failure);
    expect(failed.controls).toMatchObject([{ next: null, outcome: 'failed', failure }]);
    expect(failed.lists).toHaveLength(0);
  }
  const collection = renderWindow({ page: page(true), collections: true });
  expect(collection.collections).toEqual([{ locale: 'en' }]);
  const invalid = renderWindow({ page: page(true), collections: true, section: { ok: false, status: 400 } });
  expect(invalid.collections).toEqual([{ locale: 'en', failed: true, invalid: true }]);
});

test('withheld views retire the live contribution window and malformed native continuations stay unavailable', () => {
  const hidden = renderWindow({ page: page(), hidden: true });
  expect(hidden.html).toBe('');
  expect(hidden.retire).toHaveBeenCalledTimes(1);
  const source = page();
  source.reads.r1 = { status: 200, body: { posts: [], next: 'x'.repeat(4097) } };
  const malformed = renderWindow({ page: source });
  expect(malformed.html).toContain('data-state="failed"');
  expect(malformed.controls).toMatchObject([{ outcome: 'failed', failure: 'unavailable' }]);
});
