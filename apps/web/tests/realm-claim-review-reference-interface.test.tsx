import { expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { RealmClaimReviewView } from '../src/community/realm-claim-review-page';
import type {
  RealmClaimApprovalInput,
  RealmClaimApprovalResult,
  RealmClaimReviewAdapter,
  RealmClaimReviewRead,
} from '../src/community/realm-claim-review';
import { createRealmClaimCallerLifetime } from '../src/community/realm-claim-caller-lifetime';
import { pendingReview, reviewExample, reviewRequest } from '../src/stories/patterns/realm-claim-review/example';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

// Authored, UNRUN. This mounts the actual page/controller; only supplied adapter responses are fixtures.
// DOM checks retain full text and responsive classes. The canonical story's browser assertions additionally
// measure actual wrapping/44px targets and native keyboard disclosure activation at 390px and 1280px.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Realm claim review prioritizes the human request and preserves visible approval identity dates outcomes and reachable exact references', async () => {
  const previousLocale = getLocale();
  const window = new Window({ url: 'https://site.test/en/realms/example/claims' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const fetches = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('The review presentation must not add network work');
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const empty: RealmClaimReviewRead = { kind: 'ready', page: { claimRequests: [], next: null } };
  type Props = Parameters<typeof RealmClaimReviewView>[0];
  async function mount(props: Omit<Props, 'realmId'>, width = 390, direction = 'ltr') {
    if (root) await act(async () => root!.unmount());
    host.style.width = `${width}px`;
    host.dir = direction;
    window.happyDOM.setWindowSize({ width, height: 900 });
    root = createRoot(host);
    await act(async () => {
      root!.render(<RealmClaimReviewView realmId={reviewRequest.realmId} {...props} />);
      await tick();
    });
  }
  function button(label: string, region: ParentNode = host) {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].filter(
      (node) => node.textContent?.trim() === label,
    );
    expect(found).toHaveLength(1);
    return found[0]!;
  }
  async function click(label: string, region: ParentNode = host) {
    await act(async () => {
      const target = button(label, region);
      target.focus();
      target.click();
      await tick();
    });
  }
  function identity(region: ParentNode, value = reviewRequest.claimantAccountId) {
    const found = [...region.querySelectorAll('dd')].find((node) => node.textContent === value);
    expect(found).toBeDefined();
    expect(found!.previousElementSibling?.textContent).toBe(m.realm_review_claimant());
    expect(found!.closest('details')).toBeNull();
    const reference = found!.querySelector('span')!;
    expect(reference.dir).toBe('ltr');
    expect(reference.classList.contains('select-all')).toBe(true);
    expect(reference.classList.contains('break-all')).toBe(true);
  }
  async function references(region: ParentNode, requestId = reviewRequest.requestId) {
    const details = [...region.querySelectorAll('details')].find((node) => node.textContent?.includes(requestId));
    expect(details).toBeDefined();
    const summary = details!.querySelector('summary')!;
    expect(summary.textContent).toBe(m.realm_review_details_heading());
    expect(summary.classList.contains('min-h-11')).toBe(true);
    expect(summary.className).toContain('focus-visible:outline-2');
    summary.focus();
    expect(window.document.activeElement).toBe(summary);
    await act(async () => {
      summary.click();
      await tick();
    });
    expect(details!.open).toBe(true);
    const values = [...details!.querySelectorAll('dd')].map((node) => node.textContent);
    expect(values).toEqual([reviewRequest.realmId, requestId]);
    for (const value of [reviewRequest.realmId, requestId]) {
      const reference = [...details!.querySelectorAll('span')].find((node) => node.textContent === value)!;
      expect(reference.dir).toBe('ltr');
      expect(reference.className).toContain('select-all');
      expect(reference.className).toContain('break-all');
      expect(reference.className).toContain('whitespace-normal');
      expect(reference.className).toContain('max-w-full');
    }
  }
  function noIdentity() {
    for (const value of [reviewRequest.realmId, reviewRequest.requestId, reviewRequest.claimantAccountId])
      expect(host.textContent).not.toContain(value);
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('li')).toBeNull();
    expect(host.textContent).not.toContain(m.realm_review_empty());
    expect(host.textContent).not.toContain(m.realm_review_success());
  }
  function observed(scenario: Parameters<typeof reviewExample>[0]) {
    const example = reviewExample(scenario);
    const reads: { realmId: string; cursor?: string }[] = [];
    const approvals: RealmClaimApprovalInput[] = [];
    const adapter: RealmClaimReviewAdapter = {
      read: async (input) => {
        reads.push(input);
        return example.adapter.read(input);
      },
      approve: async (input) => {
        approvals.push(input);
        return example.adapter.approve(input);
      },
    };
    return { initial: example.initial, adapter, reads, approvals };
  }
  try {
    // Exact full UUIDs are the longest references admitted by the native projection. Longer IDs would
    // be rejected, so the fixtures do not manufacture a long identifier or a claimant display name.
    for (const width of [390, 1280]) {
      for (const direction of ['ltr', 'rtl']) {
        for (const locale of ['en', 'de', 'zh-Hant'] as const) {
          setLocale(locale, { reload: false });
          const example = observed('pending');
          await mount(example, width, direction);
          expect(host.querySelectorAll('h1')).toHaveLength(1);
          expect(host.querySelector('h1')?.textContent).toBe(m.realm_review_heading());
          const queue = host.querySelector('ul')!;
          const queueHeading = host.querySelector('h2')!;
          expect(queueHeading.textContent).toBe(m.realm_review_queue());
          expect(queueHeading.textContent).not.toContain(reviewRequest.realmId);
          expect(queue.getAttribute('aria-labelledby')).toBe(queueHeading.id);
          expect(queue.querySelectorAll('li')).toHaveLength(1);
          const row = queue.querySelector('li')!;
          expect(row.dataset.slot).toBe('list-row');
          expect(row.querySelector('h3')?.textContent).toBe(m.realm_review_details_request_heading());
          expect(row.className).toContain('[&_h3]:line-clamp-none');
          expect(host.querySelector('article')?.className).toContain('[overflow-wrap:anywhere]');
          expect(host.textContent).toContain(m.realm_review_guidance_dates());
          expect(host.textContent).toContain(m.realm_review_guidance_authority());
          expect(host.textContent).toContain(m.realm_review_guidance_privacy());
          expect(row.textContent).toContain(m.realm_review_pending());
          identity(row);
          for (const value of [reviewRequest.requestedAt, reviewRequest.orphanedAt, reviewRequest.claimEligibleAt]) {
            const date = row.querySelector(`time[datetime="${value}"]`)!;
            expect(date).not.toBeNull();
            expect(date.closest('details')).toBeNull();
            expect(date.textContent).toContain('UTC');
          }
          expect(row.querySelectorAll('time')).toHaveLength(3);
          await references(row);
          expect(example.reads).toHaveLength(0);
          expect(example.approvals).toHaveLength(0);
          expect(host.textContent).not.toContain(m.realm_review_confirm_heading());
          expect(host.querySelector('a a, a button, button summary')).toBeNull();
          for (const control of host.querySelectorAll('button')) {
            expect(control.className).toContain('min-h-11');
            expect(control.className).toContain('min-w-11');
            expect(control.className).toContain('whitespace-normal');
            expect(control.className).toContain('focus-visible:');
          }
          button(m.realm_review_review()).focus();
          expect(window.document.activeElement).toBe(button(m.realm_review_review()));
          await click(m.realm_review_review());
          expect(example.reads).toHaveLength(1);
          expect(example.approvals).toHaveLength(0);
          const confirmation = host.querySelector('section[aria-labelledby$="-confirm"]')!;
          expect(window.document.activeElement).toBe(confirmation);
          expect(confirmation.querySelector('h3')?.textContent).toBe(m.realm_review_confirm_heading());
          identity(confirmation);
          expect(confirmation.querySelectorAll('time')).toHaveLength(3);
          await references(confirmation);
          await click(m.realm_review_cancel());
          expect(example.approvals).toHaveLength(0);
          expect(host.querySelectorAll('li')).toHaveLength(1);
          expect(window.document.activeElement).toBe(button(m.realm_review_review()));
          expect(example.reads).toHaveLength(1);
        }
      }
    }
    const delayedReview = deferred<RealmClaimReviewRead>();
    await mount({
      initial: pendingReview,
      adapter: { read: () => delayedReview.promise, approve: reviewExample('success').adapter.approve },
    });
    await click(m.realm_review_review());
    const movedFocus = host.querySelector('h2')!;
    movedFocus.focus();
    await act(async () => {
      delayedReview.resolve(pendingReview);
      await tick();
    });
    expect(host.querySelector('section[aria-labelledby$="-confirm"]')).not.toBeNull();
    expect(window.document.activeElement).toBe(movedFocus);

    await mount(observed('pending'));
    const pointerFocus = host.querySelector('h2')!;
    pointerFocus.focus();
    await act(async () => {
      button(m.realm_review_review()).dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
      await tick();
    });
    expect(host.querySelector('section[aria-labelledby$="-confirm"]')).not.toBeNull();
    expect(window.document.activeElement).toBe(pointerFocus);

    setLocale('en', { reload: false });
    const second = {
      ...reviewRequest,
      requestId: '01a1a000-0000-7000-8000-000000000098',
      claimantAccountId: '01a1a000-0000-7000-8000-000000000034',
    };
    const cursor = 'opaque.cursor+/keep?signature=%2F&scope=exact';
    const nextReads: unknown[] = [];
    await mount({
      initial: { kind: 'ready', page: { claimRequests: [], next: cursor } },
      adapter: {
        read: async (input) => {
          nextReads.push(input);
          return { kind: 'ready', page: { claimRequests: [second, reviewRequest], next: null } };
        },
        approve: reviewExample('denied').adapter.approve,
      },
    });
    expect(host.textContent).toContain(m.realm_review_sparse());
    expect(host.textContent).not.toContain(m.realm_review_empty());
    expect(nextReads).toHaveLength(0);
    await click(m.realm_review_next());
    expect(nextReads).toEqual([{ realmId: reviewRequest.realmId, cursor }]);
    const rows = [...host.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    identity(rows[0]!, second.claimantAccountId);
    identity(rows[1]!);
    expect(host.textContent).not.toContain(m.realm_review_next());

    const failedCursor = 'expired.signed.cursor';
    const recoveryReads: unknown[] = [];
    const recoveryApprovals: RealmClaimApprovalInput[] = [];
    await mount({
      initial: { kind: 'ready', page: { claimRequests: [], next: failedCursor } },
      adapter: {
        read: async (input) => {
          recoveryReads.push(input);
          return recoveryReads.length < 3 ? { kind: 'unavailable' } : empty;
        },
        approve: async (input) => {
          recoveryApprovals.push(input);
          return { kind: 'unavailable' };
        },
      },
    });
    await click(m.realm_review_next());
    await click(m.realm_review_retry_page());
    expect(recoveryReads).toEqual([
      { realmId: reviewRequest.realmId, cursor: failedCursor },
      { realmId: reviewRequest.realmId, cursor: failedCursor },
    ]);
    expect(window.document.activeElement).toBe(button(m.realm_review_retry_page()));
    await click(m.realm_review_restart());
    expect(recoveryReads).toEqual([
      { realmId: reviewRequest.realmId, cursor: failedCursor },
      { realmId: reviewRequest.realmId, cursor: failedCursor },
      { realmId: reviewRequest.realmId },
    ]);
    expect(window.document.activeElement).toBe(host.querySelector('section[aria-labelledby$="-queue"] h2'));
    expect(recoveryApprovals).toHaveLength(0);

    await mount(reviewExample('empty'));
    expect(host.textContent).toContain(m.realm_review_empty());
    expect(host.textContent).not.toContain(m.realm_review_sparse());
    expect(host.textContent).not.toContain(m.realm_review_next());

    for (const kind of ['unavailable', 'denied', 'signed-out', 'closed'] as const) {
      await mount({ initial: { kind }, adapter: reviewExample('denied').adapter });
      noIdentity();
    }
    await mount({ ...observed('pending'), ready: false });
    noIdentity();
    const loading = deferred<RealmClaimReviewRead>();
    let loadingReads = 0;
    await mount({
      initial: pendingReview,
      load: true,
      adapter: {
        read: () => {
          loadingReads++;
          return loading.promise;
        },
        approve: reviewExample('denied').adapter.approve,
      },
    });
    expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).toContain(m.realm_review_working());
    noIdentity();
    expect(loadingReads).toBe(1);
    await act(async () => {
      loading.resolve({ kind: 'denied' });
      await tick();
    });
    expect(host.textContent).toContain(m.realm_review_denied());
    noIdentity();

    const success = observed('success');
    await mount(success);
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    expect(window.document.activeElement).toBe(host.querySelector('article[role="status"] > div'));
    expect(success.approvals).toHaveLength(1);
    expect(success.reads).toHaveLength(2);
    const receipt = host.querySelector('article[role="status"]')!;
    expect(receipt.querySelector('h3')?.textContent).toContain(m.realm_review_success());
    identity(receipt);
    expect(receipt.querySelector(`time[datetime="${reviewRequest.orphanedAt}"]`)).not.toBeNull();
    expect(receipt.querySelector('time[datetime="2026-10-31T10:05:00.000Z"]')).not.toBeNull();
    await references(receipt);
    await click(m.realm_review_review_current());
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(success.reads).toHaveLength(2);
    expect(success.approvals).toHaveLength(1);

    const uncertain = observed('uncertain');
    await mount(uncertain);
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    expect(window.document.activeElement).toBe(button(m.realm_review_inspect_original()));
    expect(host.textContent).toContain(m.realm_review_uncertain());
    noIdentity();
    await act(async () => {
      await tick();
    });
    expect(uncertain.approvals).toHaveLength(1);
    await click(m.realm_review_inspect_original());
    expect(uncertain.approvals).toHaveLength(1);
    await click(m.realm_review_retry());
    expect(uncertain.approvals).toEqual([uncertain.approvals[0]!, uncertain.approvals[0]!]);
    expect(uncertain.reads).toHaveLength(3);
    expect(host.textContent).toContain(m.realm_review_success());
    expect(window.document.activeElement).toBe(host.querySelector('article[role="status"] > div'));

    const conflict = observed('conflict');
    await mount(conflict);
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    expect(host.textContent).toContain(m.realm_review_conflict());
    expect(window.document.activeElement).toBe(host.querySelector('[role="alert"]'));
    noIdentity();
    await click(m.realm_review_refresh());
    expect(button(m.realm_review_review()).disabled).toBe(true);
    await click(m.realm_review_review_current());
    expect(button(m.realm_review_review()).disabled).toBe(false);
    expect(conflict.approvals).toHaveLength(1);

    await mount({
      initial: pendingReview,
      adapter: { read: reviewExample('pending').adapter.read, approve: reviewExample('denied').adapter.approve },
    });
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    expect(host.textContent).toContain(m.realm_review_denied());
    expect(window.document.activeElement?.textContent).toContain(m.realm_review_denied());
    noIdentity();

    let receiptReads = 0;
    const approved = reviewExample('success');
    await mount({
      initial: pendingReview,
      adapter: {
        read: async () => (++receiptReads === 1 ? pendingReview : receiptReads === 2 ? { kind: 'unavailable' } : empty),
        approve: approved.adapter.approve,
      },
    });
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    expect(host.textContent).toContain(m.realm_review_refresh_after_approval());
    expect(window.document.activeElement).toBe(host.querySelector('article[role="status"] > div'));
    identity(host.querySelector('article[role="status"]')!);
    await click(m.realm_review_retry_page());
    expect(host.textContent).toContain(m.realm_review_success());
    identity(host.querySelector('article[role="status"]')!);
    expect(fetches).not.toHaveBeenCalled();

    const caller = createRealmClaimCallerLifetime(() => true);
    const settlement = deferred<RealmClaimApprovalResult>();
    let input: RealmClaimApprovalInput | undefined;
    const retiredSuccess = reviewExample('success');
    await mount({
      initial: pendingReview,
      lifetime: caller,
      adapter: {
        read: async () => pendingReview,
        approve: (value) => {
          input = value;
          return settlement.promise;
        },
      },
    });
    await click(m.realm_review_review());
    await click(m.realm_review_confirm());
    caller.retire();
    await act(async () => {
      settlement.resolve(await retiredSuccess.adapter.approve(input!));
      await tick();
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    if (root) await act(async () => root!.unmount());
    fetches.mockRestore();
    host.remove();
    window.happyDOM.abort();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
