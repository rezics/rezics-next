import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RealmClaimSnapshot } from '../src/community/realm-claim';
import type {
  RealmClaimApprovalReceipt,
  RealmClaimReviewAdapter,
  RealmClaimReviewPage,
  RealmClaimReviewRequest,
} from '../src/community/realm-claim-review';
import type { RealmClaimStatus, RealmClaimStatusRead } from '../src/community/realm-claim-status';
import type { RealmBanPage, BanReadState, BanWriteInput, BanWriteResult } from '../src/community/realm-bans';
import type { RealmBanTarget } from '../src/community/realm-ban-target';
import { RealmClaimReviewView } from '../src/community/realm-claim-review-page';
import { RealmClaimStatusView } from '../src/community/realm-claim-status-page';
import { RealmBansControl } from '../src/community/realm-bans-control';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const realmId = '01a1a000-0000-7000-8000-000000000011';
const requestId = '01a1a000-0000-7000-8000-000000000099';
const claimantId = '01a1a000-0000-7000-8000-000000000033';
const accountId = '01a1a000-0000-7000-8000-000000000081';
const previousAccountId = '01a1a000-0000-7000-8000-000000000082';
const laterAccountId = '01a1a000-0000-7000-8000-000000000083';
const orphanedAt = '2026-09-01T10:00:00.000Z';
const requestedAt = '2026-10-31T10:00:00.000Z';
const approvedAt = '2026-10-31T12:34:56.000Z';
const claimRow: RealmClaimReviewRequest = {
  realmId,
  requestId,
  claimantAccountId: claimantId,
  state: 'pending',
  orphanedAt,
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
  requestedAt,
};
const claimReceipt: RealmClaimApprovalReceipt = {
  realmId,
  requestId,
  claimantAccountId: claimantId,
  state: 'owned',
  orphanedAt,
  approvedAt,
};
const claimSnapshot: RealmClaimSnapshot = {
  realmId,
  spaceId: '01a1a000-0000-7000-8000-000000000021',
  contextId: '01a1a000-0000-7000-8000-000000000022',
  headRevisionId: '01a1a000-0000-7000-8000-000000000023',
  ownershipState: 'orphaned',
  governanceReadOnly: true,
  orphanedAt,
  claimEligibleAt: '2026-10-01T10:00:00.000Z',
};
const ownClaim: RealmClaimStatus = {
  realmId,
  requestId,
  state: 'pending',
  orphanedAt,
  requestedAt,
  approvedAt: null,
  currentEpisode: true,
};
const ownClaimRead: RealmClaimStatusRead = { kind: 'ready', claimRequest: ownClaim, source: claimSnapshot };
const longBanReason =
  'Repeated disruption across several public discussions continued after two moderator notices. The interruptions prevented other members from completing their topics, so this record preserves the complete reason used for the current restriction and its original review context.';
const previousBan: RealmBanPage['items'][number] = {
  accountId: previousAccountId,
  reason: longBanReason,
  actor: null,
  at: '2026-10-30T09:15:00.000Z',
};
const target: RealmBanTarget = {
  lookupHandle: 'river',
  account: {
    id: accountId,
    kind: 'actor',
    state: 'active',
    handle: 'river',
    displayName: 'River Lin',
    movedTo: 'river-current',
    automated: false,
    operatorId: null,
  },
};

function rendered(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(element);
}

test('Realm governance views compose shared rows and case frames without truncating facts or merging withheld states', () => {
  setLocale('en', { reload: false });
  const reviewAdapter: RealmClaimReviewAdapter = {
    read: async () => ({ kind: 'ready', page: { claimRequests: [claimRow], next: null } }),
    approve: async () => ({ kind: 'approved', claim: claimReceipt }),
  };
  const review = rendered(
    createElement(RealmClaimReviewView, {
      realmId,
      initial: { kind: 'ready', page: { claimRequests: [claimRow], next: null } },
      adapter: reviewAdapter,
    }),
  );
  expect(review.match(/<h1\b/gu)).toHaveLength(1);
  expect(review).toMatch(/<ul\b[^>]*>[\s\S]*?<li\b[^>]*data-slot="list-row"/u);
  expect(review.match(/<h3\b[^>]*data-content-item-slot="title"[^>]*>([^<]*)<\/h3>/u)?.[1]).toBe(
    m.realm_review_details_request_heading(),
  );
  expect(review).toContain(m.realm_review_claimant());
  expect(review).toContain(m.realm_review_pending());
  for (const value of [orphanedAt, claimRow.claimEligibleAt, requestedAt])
    expect(review).toContain(`dateTime="${value}"`);
  expect(review.match(/<time\b/gu)).toHaveLength(3);
  expect(review.match(/UTC/gu)).toHaveLength(3);
  expect(review).toContain(m.realm_review_review());

  const sparseReview = rendered(
    createElement(RealmClaimReviewView, {
      realmId,
      initial: { kind: 'ready', page: { claimRequests: [], next: 'sparse-claim-cursor' } },
      adapter: reviewAdapter,
    }),
  );
  expect(sparseReview).toContain(m.realm_review_sparse());
  expect(sparseReview).toContain(m.realm_review_next());
  expect(sparseReview).not.toContain(m.realm_review_empty());
  const deniedReview = rendered(
    createElement(RealmClaimReviewView, {
      realmId,
      initial: { kind: 'denied' },
      adapter: reviewAdapter,
    }),
  );
  expect(deniedReview).toContain(m.realm_review_denied());
  expect(deniedReview).not.toContain(claimantId);

  const status = rendered(
    createElement(RealmClaimStatusView, {
      realmId,
      requestId,
      initial: ownClaimRead,
      adapter: { read: async () => ownClaimRead },
    }),
  );
  expect(status.match(/<h1\b/gu)).toHaveLength(1);
  expect(status).toMatch(
    /<article\b[^>]*aria-labelledby="[^"]+-case"[^>]*>[\s\S]*?<h2\b[^>]*data-content-item-slot="title"/u,
  );
  expect(status).toContain(m.realm_claim_pending());
  expect(status).toContain(m.realm_claim_review_help());
  expect(status).toContain(requestId);
  expect(status).toContain(`dateTime="${orphanedAt}"`);
  expect(status).toContain(`dateTime="${requestedAt}"`);
  expect(status).toContain(m.realm_claim_status_check_again());
  const withheldStatus = rendered(
    createElement(RealmClaimStatusView, {
      realmId,
      requestId,
      initial: { kind: 'denied' },
      adapter: { read: async () => ({ kind: 'denied' }) },
    }),
  );
  expect(withheldStatus).toContain(m.realm_claim_status_denied());
  expect(withheldStatus).not.toContain(requestId);
  expect(withheldStatus).not.toContain(orphanedAt);

  const bans = rendered(
    createElement(RealmBansControl, {
      realmId,
      initial: { state: 'ready', page: { items: [previousBan], next: 'ban-page-2' } },
      ready: true,
      resolve: async () => ({ state: 'ready', target }),
      read: async () => ({ state: 'ready', page: { items: [previousBan], next: 'ban-page-2' } }),
      write: async () => ({ ok: false, reason: 'unavailable' }),
    }),
  );
  expect(bans).toContain('<h2');
  expect(bans).toMatch(/<h3\b[^>]*>Current bans<\/h3>/u);
  expect(bans).toMatch(/<ul\b[^>]*>[\s\S]*?<li\b[^>]*data-slot="list-row"/u);
  expect(bans).toContain(previousAccountId);
  expect(bans).toContain(longBanReason);
  expect(bans).toContain(`dateTime="${previousBan.at}"`);
  expect(bans).toContain('UTC</time>');
  expect(bans).toContain(m.realm_bans_next());
  const sparseBans = rendered(
    createElement(RealmBansControl, {
      realmId,
      initial: { state: 'ready', page: { items: [], next: 'ban-sparse-cursor' } },
      ready: true,
      resolve: async () => ({ state: 'ready', target }),
      read: async () => ({ state: 'ready', page: { items: [], next: 'ban-sparse-cursor' } }),
      write: async () => ({ ok: false, reason: 'unavailable' }),
    }),
  );
  expect(sparseBans).toContain(m.realm_bans_empty());
  expect(sparseBans).toContain(m.realm_bans_next());
  const withheldBans = rendered(
    createElement(RealmBansControl, {
      realmId,
      initial: { state: 'forbidden' },
      ready: true,
      resolve: async () => ({ state: 'refused' }),
      read: async () => ({ state: 'forbidden' }),
      write: async () => ({ ok: false, reason: 'forbidden' }),
    }),
  );
  expect(withheldBans).toContain(m.realm_bans_forbidden());
  expect(withheldBans).not.toContain(previousAccountId);
  expect(withheldBans).not.toContain(longBanReason);
});

test('claim approval and ban target forms keep confirmation, uncertain retry and current recovery independently operable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/realms/example' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = () => act(async () => new Promise((done) => setTimeout(done, 0)));
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
  const click = async (name: string) => {
    const candidate = button(name);
    if (!candidate) throw new Error(`Missing button: ${name}`);
    await act(async () => candidate.click());
    await flush();
  };

  let page: RealmBanPage = { items: [previousBan], next: 'ban-page-1' };
  const banReads: (string | undefined)[] = [];
  const resolveCalls: string[] = [];
  const writeCalls: BanWriteInput[] = [];
  const sparseBan: RealmBanPage['items'][number] = {
    accountId: laterAccountId,
    reason: 'A later current ban on the explicitly requested page.',
    actor: null,
    at: '2026-10-31T13:00:00.000Z',
  };
  const nextPage = (cursor?: string): BanReadState => {
    banReads.push(cursor);
    if (!cursor) return { state: 'ready', page };
    if (cursor === 'ban-page-1') return { state: 'ready', page: { items: [], next: 'ban-page-2' } };
    return { state: 'ready', page: { items: [sparseBan], next: null } };
  };
  let firstBanReply = true;
  const reviewCalls: Parameters<RealmClaimReviewAdapter['approve']>[0][] = [];
  const reviewReads: (string | undefined)[] = [];
  let reviewPage: RealmClaimReviewPage = { claimRequests: [], next: 'claim-page-1' };
  let firstClaimReply = true;
  const reviewAdapter: RealmClaimReviewAdapter = {
    read: async ({ cursor }) => {
      reviewReads.push(cursor);
      if (cursor === 'claim-page-1') return { kind: 'ready', page: { claimRequests: [], next: 'claim-page-2' } };
      if (cursor === 'claim-page-2') reviewPage = { claimRequests: [claimRow], next: null };
      return { kind: 'ready', page: reviewPage };
    },
    approve: async (input) => {
      reviewCalls.push(input);
      return firstClaimReply
        ? ((firstClaimReply = false), { kind: 'unavailable' })
        : { kind: 'approved', claim: claimReceipt };
    },
  };
  let rootMounted = false;

  try {
    setLocale('en', { reload: false });
    await act(async () =>
      root.render(
        createElement(RealmClaimReviewView, {
          realmId,
          initial: { kind: 'ready', page: reviewPage },
          adapter: reviewAdapter,
        }),
      ),
    );
    rootMounted = true;
    await flush();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.textContent).toContain(m.realm_review_sparse());
    await click(m.realm_review_next());
    expect(host.textContent).toContain(m.realm_review_sparse());
    expect(button(m.realm_review_next())).toBeTruthy();
    await click(m.realm_review_next());
    expect(reviewReads.slice(0, 2)).toEqual(['claim-page-1', 'claim-page-2']);
    expect(host.textContent).toContain(claimantId);
    const claimantFact = [...host.querySelectorAll('ul > li dl > div')].find(
      (candidate) => candidate.querySelector('dt')?.textContent === m.realm_review_claimant(),
    );
    expect(claimantFact?.querySelector('dd')?.textContent).toBe(claimantId);
    expect(claimantFact?.closest('details')).toBeNull();
    await click(m.realm_review_review());
    expect(host.querySelector('section[aria-labelledby] h3')?.textContent).toBe(m.realm_review_confirm_heading());
    expect(button(m.realm_review_confirm())).toBeTruthy();
    expect(button(m.realm_review_cancel())).toBeTruthy();
    await click(m.realm_review_confirm());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.realm_review_uncertain());
    expect(button(m.realm_review_retry())).toBeTruthy();
    await click(m.realm_review_retry());
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[1]).toEqual(reviewCalls[0]);
    expect(host.textContent).toContain(m.realm_review_success());
    expect(host.textContent).toContain(claimReceipt.claimantAccountId);
    expect(host.querySelector(`time[datetime="${approvedAt}"]`)).toBeTruthy();

    const deniedStatus: RealmClaimStatusRead = { kind: 'denied' };
    await act(async () =>
      root.render(
        createElement(RealmClaimStatusView, {
          key: 'available-status',
          realmId,
          requestId,
          initial: ownClaimRead,
          adapter: { read: async () => ownClaimRead },
        }),
      ),
    );
    await flush();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('article[aria-labelledby] h2')?.textContent).toBe(m.realm_claim_pending());
    expect(host.querySelector(`time[datetime="${requestedAt}"]`)).toBeTruthy();
    expect(button(m.realm_claim_status_check_again())).toBeTruthy();
    await act(async () =>
      root.render(
        createElement(RealmClaimStatusView, {
          key: 'withheld-status',
          realmId,
          requestId,
          initial: deniedStatus,
          adapter: { read: async () => deniedStatus },
        }),
      ),
    );
    await flush();
    expect(host.textContent).toContain(m.realm_claim_status_denied());
    expect(host.textContent).not.toContain(requestId);
    expect(host.textContent).not.toContain(orphanedAt);

    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement('h1', null, 'Space'),
          createElement(RealmBansControl, {
            realmId,
            initial: { state: 'ready', page },
            ready: true,
            resolve: async (handle) => {
              resolveCalls.push(handle);
              return { state: 'ready', target };
            },
            read: async (cursor) => nextPage(cursor),
            write: async (input): Promise<BanWriteResult> => {
              writeCalls.push({ ...input });
              if (firstBanReply) {
                firstBanReply = false;
                return { ok: false, reason: 'unavailable' };
              }
              page = {
                items: [
                  previousBan,
                  { accountId: input.accountId, reason: input.reason, actor: accountId, at: approvedAt },
                ],
                next: 'ban-page-1',
              };
              return {
                ok: true,
                action: 'ban',
                ban: {
                  realmId,
                  accountId: input.accountId,
                  reason: input.reason,
                  actor: accountId,
                  at: approvedAt,
                  workflowId: 'membership-removal',
                },
              };
            },
          }),
        ),
      ),
    );
    await flush();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.textContent).toContain(longBanReason);
    expect(host.querySelector(`time[datetime="${previousBan.at}"]`)).toBeTruthy();

    for (const details of host.querySelectorAll('details')) details.open = false;
    const previousRow = [...host.querySelectorAll('ul > li')].find((candidate) =>
      [...candidate.querySelectorAll('dt')].some(
        (label) =>
          label.textContent === m.realm_bans_details_account() &&
          label.nextElementSibling?.textContent === previousAccountId &&
          label.closest('li') === candidate &&
          !label.closest('details') &&
          !label.nextElementSibling.closest('details'),
      ),
    );
    expect(previousRow?.parentElement?.getAttribute('aria-label')).toBe(m.realm_bans_current());
    expect(previousRow?.querySelector('h4')?.textContent).toBe(m.realm_bans_details_banned_heading());
    const disclosedAccount = [...(previousRow?.querySelectorAll('dt') ?? [])].find(
      (label) => label.textContent === m.realm_bans_details_account(),
    )?.nextElementSibling;
    expect(disclosedAccount?.textContent).toBe(previousAccountId);
    expect(disclosedAccount?.closest('details, [hidden], [aria-hidden="true"]')).toBeNull();
    const unbanButton = [...(previousRow?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === m.realm_bans_unban(),
    );
    if (!unbanButton) throw new Error('The existing ban row should expose its own unban action.');
    await act(async () => unbanButton.click());
    await flush();
    expect(host.textContent).toContain(m.realm_bans_unban_confirm());
    expect(button(m.realm_bans_confirm())).toBeTruthy();
    expect(button(m.realm_bans_cancel())).toBeTruthy();
    expect(writeCalls).toHaveLength(0);
    await click(m.realm_bans_cancel());
    expect(host.textContent).not.toContain(m.realm_bans_unban_confirm());

    const accountInput = host.querySelector<HTMLInputElement>('input');
    const reasonInput = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!accountInput || !reasonInput) throw new Error('The ban target and reason fields should be present.');
    await act(async () => user.type(accountInput, '@river'));
    await click(m.realm_bans_target_lookup());
    const preview = host.querySelector<HTMLElement>('[data-slot="realm-ban-target-preview"]');
    expect(preview?.textContent).toContain('River Lin');
    expect(preview?.textContent).toContain('@river');
    expect(preview?.textContent).toContain(m.realm_bans_target_moved({ former: 'river', current: 'river-current' }));
    expect(preview?.textContent).toContain('RL');
    expect(preview?.textContent).not.toContain(accountId);
    expect(preview?.querySelector('a')).toBeNull();
    expect(resolveCalls).toEqual(['river']);
    await click(m.realm_bans_target_select());
    await act(async () => user.type(reasonInput, longBanReason));
    await click(m.realm_bans_ban());
    expect(host.textContent).toContain(m.realm_bans_ban_confirm());
    expect(host.textContent).toContain(longBanReason);
    expect(host.querySelectorAll('button').length).toBeGreaterThan(2);
    await click(m.realm_bans_confirm_ban());
    expect(resolveCalls).toEqual(['river', 'river']);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.realm_bans_write_unavailable());
    expect(button(m.realm_bans_retry())).toBeTruthy();
    expect(reasonInput.disabled).toBe(true);
    await click(m.realm_bans_retry());
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[1]).toEqual(writeCalls[0]);
    expect(host.textContent).toContain(m.realm_bans_active());
    expect(host.textContent).toContain(m.realm_bans_removal_pending());
    expect(host.textContent).toContain(longBanReason);
    expect(host.querySelector(`time[datetime="${approvedAt}"]`)).toBeTruthy();

    await click(m.realm_bans_next());
    expect(banReads).toEqual([undefined, 'ban-page-1']);
    expect(host.textContent).toContain(m.realm_bans_empty());
    expect(button(m.realm_bans_next())).toBeTruthy();
    expect(host.textContent).not.toContain(laterAccountId);
    await click(m.realm_bans_next());
    expect(banReads).toEqual([undefined, 'ban-page-1', 'ban-page-2']);
    expect(host.textContent).toContain(laterAccountId);
    expect(button(m.realm_bans_next())).toBeNull();
  } finally {
    if (rootMounted) await act(async () => root.unmount());
    setLocale('en', { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
