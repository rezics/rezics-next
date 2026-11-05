import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act, createRef, type ComponentProps } from 'react';
import accounts from '../src/kernel/recorded/accounts.json';
import recorded from '../src/kernel/recorded/thread-posts.json';
import type { PageAuthors } from '../src/identity/read';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import type { ThreadPost } from '../src/threads/reads';

// Component-boundary acceptance: native authority and browser layout remain separate obligations.
const source = recorded.posts[0]!;
const deadline = '2099-11-23T03:04:05.000Z';
const reviewId = '0192f3a0-6c1e-7b2a-9d4e-000000000061';
const decisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000062/reference?appeal=read';
const privateBody = 'Private removed body must never escape into text or attributes.';
const privateTitle = 'Private deleted opening title must never escape.';
const authors = Object.fromEntries(accounts.accounts.map((account) => [account.id, account])) as PageAuthors;
type Props = ComponentProps<typeof import('../src/threads/post-removed').RemovedPost>;

function erased(index: number, restorableUntil?: string): ThreadPost {
  const post = recorded.posts[index]!;
  return {
    id: post.id,
    threadId: post.threadId,
    route: post.route,
    parentId: post.parentId,
    availability: 'erased',
    removed: true,
    body: null,
    sha256: null,
    ...(restorableUntil === undefined ? {} : { restorableUntil }),
  };
}

function props(post: ThreadPost, extra: Partial<Props> = {}): Props {
  return {
    post,
    authors,
    now: '2026-11-02T00:00:00.000Z',
    viewerId: source.authorId,
    anchorId: `post-${post.id}`,
    itemRef: null,
    menuButton: null,
    onCopyLink: () => {},
    ...extra,
  };
}

async function domWindow(width = 390) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  return new Window({ url: 'https://site.test/en/threads/recovery', width, height: 844 });
}

function installDomGlobals(window: Awaited<ReturnType<typeof domWindow>>) {
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

test('Complete usable removed post recovery and write prompts: native admission and private text/attribute absence', async () => {
  const window = await domWindow();
  // Load the actual menu after DOM setup so its portal can also be exercised by the next test.
  const restoreGlobals = installDomGlobals(window);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LocaleProvider } = await import('@rezics/ui/locale');
  const { RemovedPost } = await import('../src/threads/post-removed');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const root = window.document.createElement('div');
  const withheld: ThreadPost = {
    ...source,
    visibility: 'published',
    availability: 'withheld',
    removed: true,
    body: null,
    sha256: null,
    decisionId,
  };
  const { decisionId: _decision, ...withoutDecision } = withheld;
  const cases: {
    label: string;
    value: Props;
    restore: boolean;
    decision: boolean;
    identity: boolean;
    time?: string;
  }[] = [
    {
      label: 'author with supplied deadline',
      value: props(erased(0, deadline), { onRestore: () => {} }),
      restore: true,
      decision: false,
      identity: false,
      time: deadline,
    },
    {
      label: 'another reader without native eligibility',
      value: props(erased(0), { viewerId: 'another-reader' }),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'signed out',
      value: props(erased(0, deadline), { viewerId: undefined, onRestore: () => {} }),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'no supplied callback',
      value: props(erased(0, deadline)),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'expired deadline',
      value: props(erased(0, '2000-01-01T00:00:00.000Z'), { onRestore: () => {} }),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'invalid deadline',
      value: props(erased(0, 'unknown'), { onRestore: () => {} }),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'unknown server clock',
      value: props(erased(0), { deadlineUnknown: true, onRestore: () => {} }),
      restore: true,
      decision: false,
      identity: false,
    },
    {
      label: 'unknown clock without command authority',
      value: props(erased(0), { deadlineUnknown: true }),
      restore: false,
      decision: false,
      identity: false,
    },
    {
      label: 'withheld author',
      value: props(withheld, { onRestore: () => {} }),
      restore: false,
      decision: true,
      identity: true,
      time: source.createdAt,
    },
    {
      label: 'withheld other reader',
      value: props(withheld, { viewerId: 'another-reader', onRestore: () => {} }),
      restore: false,
      decision: false,
      identity: true,
      time: source.createdAt,
    },
    {
      label: 'withheld without admitted decision',
      value: props(withoutDecision),
      restore: false,
      decision: false,
      identity: true,
      time: source.createdAt,
    },
    {
      label: 'restored command awaiting readable content',
      value: props(erased(0, deadline), { restored: true, onRestore: () => {} }),
      restore: false,
      decision: false,
      identity: false,
    },
  ];
  try {
    for (const example of cases) {
      // Adversarial stale bytes must not become a title, hidden node, link, tooltip or data attribute.
      const poisoned = {
        ...example.value.post,
        body: { text: privateBody },
        title: privateTitle,
      } as unknown as ThreadPost;
      root.innerHTML = renderToStaticMarkup(
        <LocaleProvider locale="en">
          <ol>
            <RemovedPost {...example.value} post={poisoned} />
          </ol>
        </LocaleProvider>,
      );
      const row = root.querySelector('li')!;
      const restore = [...row.querySelectorAll('button')].filter(
        (button) => button.textContent === m.thread_post_restore(),
      );
      expect(restore.length, example.label).toBe(Number(example.restore));
      expect(Boolean(row.querySelector('a[href^="/moderation/decisions/"]')), example.label).toBe(example.decision);
      expect(row.textContent?.includes('Mira Okabe'), example.label).toBe(example.identity);
      if (example.identity) expect(row.querySelector('a[href="/en/@mira"]')).not.toBeNull();
      else {
        expect(row.querySelector('a[href*="/@"]')).toBeNull();
        for (const element of [row, ...row.querySelectorAll('*')]) {
          for (const attribute of element.attributes) {
            expect(attribute.value, example.label).not.toContain(source.authorId);
            expect(attribute.value, example.label).not.toContain('Mira Okabe');
          }
        }
      }
      if (example.label === 'another reader without native eligibility' || example.label === 'signed out')
        expect(row.querySelector('button')).toBeNull();
      expect(row.querySelector('time')?.getAttribute('datetime') ?? undefined, example.label).toBe(example.time);
      if (example.decision)
        expect(row.querySelector('a[href^="/moderation/"]')?.getAttribute('href')).toBe(
          `/moderation/decisions/${encodeURIComponent(decisionId)}`,
        );
      if (example.value.deadlineUnknown) expect(row.textContent).toContain(m.thread_post_restore_deadline_unknown());
      if (example.value.restored) expect(row.textContent).toContain(m.thread_post_unavailable());
      expect(row.id).toBe(example.value.anchorId);
      expect(row.tabIndex).toBe(-1);
      expect(row.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
      expect(row.querySelector('[data-slot="document-body"], details')).toBeNull();
      for (const secret of [privateBody, privateTitle, 'Flight notes', 'Watch the baobabs']) {
        expect(row.textContent, example.label).not.toContain(secret);
        for (const element of [row, ...row.querySelectorAll('*')]) {
          for (const attribute of element.attributes) expect(attribute.value, example.label).not.toContain(secret);
        }
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
    restoreGlobals();
    await window.happyDOM.close();
  }
});

test('Complete usable removed post recovery and write prompts: independent callbacks, pending, failure, refresh and focus', async () => {
  const window = await domWindow(1280);
  const restoreGlobals = installDomGlobals(window);
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const { LocaleProvider } = await import('@rezics/ui/locale');
  const { RemovedPost } = await import('../src/threads/post-removed');
  const { ExistingReviewNotice, SignInPrompt } = await import('../src/threads/write-prompts');
  const { createRoot } = await import('react-dom/client');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const rows = [createRef<HTMLLIElement>(), createRef<HTMLLIElement>()];
  const menus = [createRef<HTMLButtonElement>(), createRef<HTMLButtonElement>()];
  const restores = [0, 0];
  const refreshes = [0, 0];
  const copies = [0, 0];
  let pending = false;
  let restored = false;
  let failure: string | undefined;
  const longReference = 'native-reference-'.repeat(32);
  const error = `Native restoration failed. ${longReference}`;
  const returnTo = `/de/threads/${source.threadId}/lange-referenz?value=${longReference}&mode=review#post-${source.id}`;
  const longLabel = 'Melden Sie sich an, um zu Ihrem gespeicherten Diskussionsbeitrag zurückzukehren. '.repeat(4);
  // This is the caller's pending guard, not a new pending state or retry inside RemovedPost.
  const restoreFirst = () => {
    if (!pending) {
      pending = true;
      restores[0]++;
    }
  };
  const restoreSecond = () => {
    restores[1]++;
  };
  const render = () => (
    <LocaleProvider locale="de">
      <ol>
        <RemovedPost
          {...props(erased(0, deadline), {
            anchorId: 'independent-recovery-first',
            itemRef: rows[0],
            menuButton: menus[0],
            minHeight: 320,
            onRestore: restoreFirst,
            onCopyLink: () => {
              copies[0]++;
            },
            onRefresh: () => {
              refreshes[0]++;
            },
            restoreError: failure,
            existingReviewId: failure ? reviewId : undefined,
            restored,
          })}
        />
        <RemovedPost
          {...props(erased(1), {
            anchorId: 'independent-recovery-second',
            itemRef: rows[1],
            menuButton: menus[1],
            minHeight: 280,
            deadlineUnknown: true,
            restoreError: error,
            existingReviewId: reviewId,
            onRestore: restoreSecond,
            onCopyLink: () => {
              copies[1]++;
            },
            onRefresh: () => {
              refreshes[1]++;
            },
          })}
        />
      </ol>
      <div id="long-write-prompts">
        <SignInPrompt returnTo={returnTo} label={longLabel} />
        <SignInPrompt compact returnTo={returnTo} label={'登入後返回這篇討論並繼續閱讀與回覆。'.repeat(12)} />
        <ExistingReviewNotice reviewId={reviewId} />
      </div>
    </LocaleProvider>
  );
  const button = (index: number, label: string) =>
    [...rows[index]!.current!.querySelectorAll('button')].find((element) => element.textContent === label)!;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  };
  const keyboard = async (element: HTMLElement, keys: string) => {
    await act(async () => {
      element.focus();
      await user.keyboard(keys);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  };

  try {
    await act(async () => {
      root.render(render());
    });
    expect(restores).toEqual([0, 0]);
    expect(refreshes).toEqual([0, 0]);
    const first = rows[0]!.current!;
    const second = rows[1]!.current!;
    const firstMenu = menus[0]!.current!;
    const secondMenu = menus[1]!.current!;
    expect(first).not.toBe(second);
    expect(firstMenu).not.toBe(secondMenu);
    expect(first.style.minHeight).toBe('320px');
    expect(second.style.minHeight).toBe('280px');
    expect(first.querySelector('time')?.dateTime).toBe(deadline);
    expect(second.querySelector('time')).toBeNull();
    expect(second.textContent).toContain(m.thread_post_restore_deadline_unknown());
    expect(second.querySelector('[role="alert"]')?.textContent).toContain(error);
    expect(second.querySelector('a')?.getAttribute('href')).toBe(`/en/threads/${reviewId}`);
    const restore = button(0, m.thread_post_restore());
    const refresh = button(1, m.thread_post_refresh());
    // Native controls currently stay enabled; duplicate suppression belongs to the caller's intent.
    expect(restore.disabled).toBe(false);
    expect(refresh.disabled).toBe(false);
    await keyboard(restore, '{Enter}');
    await click(restore);
    expect(restores).toEqual([1, 0]);
    expect(pending).toBe(true);
    await keyboard(refresh, ' ');
    await keyboard(button(1, m.thread_post_restore()), '{Enter}');
    expect(refreshes).toEqual([0, 1]);
    expect(restores).toEqual([1, 1]);
    expect(first.querySelector('[data-slot="tombstone"]')).not.toBeNull();
    expect(second.querySelector('[role="alert"]')?.textContent).toContain(error);

    pending = false;
    failure = error;
    await act(async () => {
      root.render(render());
    });
    expect(rows[0]!.current).toBe(first);
    expect(menus[0]!.current).toBe(firstMenu);
    expect(first.querySelector('[role="alert"]')?.textContent).toContain(error);
    await click(button(0, m.thread_post_refresh()));
    expect(refreshes).toEqual([1, 1]);
    expect(restores).toEqual([1, 1]);
    expect(first.querySelector('[data-slot="tombstone"]')).not.toBeNull();
    expect(first.style.minHeight).toBe('320px');
    firstMenu.focus();
    expect(window.document.activeElement).toBe(menus[0]!.current);
    await keyboard(firstMenu, '{Enter}');
    const copy = [...window.document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === m.thread_content_copy_link(),
    )!;
    expect(copy).toBeDefined();
    await keyboard(copy as unknown as HTMLElement, '{Enter}');
    expect(copies).toEqual([1, 0]);
    expect(window.document.activeElement).toBe(menus[0]!.current);
    secondMenu.focus();
    expect(window.document.activeElement).toBe(secondMenu);
    await keyboard(secondMenu, '{Enter}');
    const secondCopy = [...window.document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === m.thread_content_copy_link(),
    )!;
    expect(secondCopy).toBeDefined();
    await keyboard(secondCopy as unknown as HTMLElement, '{Enter}');
    expect(copies).toEqual([1, 1]);
    expect(window.document.activeElement).toBe(menus[1]!.current);
    restored = true;
    await act(async () => {
      root.render(render());
    });
    expect(rows[0]!.current).toBe(first);
    expect(first.textContent).toContain(m.thread_post_unavailable());
    expect(button(0, m.thread_post_restore())).toBeUndefined();
    expect(first.style.minHeight).toBe('320px');
    menus[0]!.current!.focus();
    expect(window.document.activeElement).toBe(menus[0]!.current);
    first.focus();
    expect(window.document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(-1);
    expect(host.querySelectorAll('[id]').length).toBe(
      new Set([...host.querySelectorAll('[id]')].map((element) => element.id)).size,
    );
    const prompts = host.querySelector('#long-write-prompts')!;
    const links = [...prompts.querySelectorAll('a')];
    expect(links).toHaveLength(3);
    expect(links[0]?.textContent).toBe(longLabel);
    for (const link of links.slice(0, 2)) {
      expect(link.getAttribute('href')).toBe(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      link.focus();
      expect(window.document.activeElement).toBe(link);
    }
    expect(links[2]?.getAttribute('href')).toBe(`/en/threads/${reviewId}`);
    expect(host.querySelector('details')).toBeNull();
    // Layout, focus indication and 44px measurements are browser observations in the canonical story.
  } finally {
    await act(async () => {
      root.unmount();
    });
    setLocale(previousLocale, { reload: false });
    restoreGlobals();
    await window.happyDOM.close();
  }
});
