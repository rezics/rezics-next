import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { readerTestRuntime as runtime } from './agent-reader-lifetime.test';

// Exercise the real caller adapter and public composition; only the existing native transport is deferred.
for (const view of ['overview', 'posts'] as const) {
  test(`mounted public ${view} recovers preferences without replacing public navigation or return recovery`, async () => {
    const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
    const window = new Window({ url: `https://rezics.test/en/@mira${view === 'posts' ? '/posts?cursor=a%2Bb#reading' : ''}` });
    const restore = runtime.installWindow(window);
    const [{ createRoot }, { QueryClient, QueryClientProvider }, { useProfileReading }, { PublicProfilePage }, fixtures,
      { subjectPageMessages, viewTabLabels }, { subjectTabs }, { rememberContribution }] = await Promise.all([
      import('react-dom/client'), import('@tanstack/react-query'),
      import('../src/accounts/public-profile/reader-presentation/adapter'),
      import('../src/accounts/public-profile/page'),
      import('../src/stories/pages/accounts-public-profile/fixtures'),
      import('../src/features/pages/route-support'), import('../src/features/pages/views'),
      import('../src/accounts/public-profile/contributions/navigation'),
    ]);
    runtime.reset();
    runtime.setReader('reader-a');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-a', csrfToken: null });
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);
    let page = view === 'overview' ? fixtures.profilePage({ verified: true }) : fixtures.contributionPage('posts');
    runtime.markCoversWithheld(page.reads);
    const publicReads = JSON.stringify(page.reads);
    let handle = 'mira';
    let locale = 'en';
    let enabled = true;
    function Caller() {
      const reading = useProfileReading({ handle, locale, path: view === 'overview' ? { kind: 'overview' } : { kind: 'view', view }, enabled, owner: page });
      return enabled ? createElement(PublicProfilePage, {
        page, locale, reading, messages: subjectPageMessages(), publicRealms: true,
        tabs: subjectTabs(page), tabLabels: viewTabLabels(), base: `/${locale}/@${handle}`,
        ...(view === 'posts' ? { view, heading: { title: 'Mira Okabe', label: 'Posts', href: `/${locale}/@${handle}` } } : {}),
        renderJsonLd: false,
      }) : createElement('p', null, 'Public page unavailable');
    }
    const render = async () => {
      await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Caller))));
      await runtime.settle();
    };
    const nextRead = async (count: number) => {
      for (let attempt = 0; attempt < 30 && runtime.nativeReads.length < count; attempt++) await runtime.settle();
      expect(runtime.nativeReads).toHaveLength(count);
      return runtime.nativeReads[count - 1]!;
    };
    const status = () => host.querySelector('[data-slot="profile-reading"] [role="status"]')!;
    const retry = () => host.querySelector<HTMLButtonElement>('[data-slot="profile-reading"] button')!;
    const safe = () => expect(host.querySelector('[data-slot="cover"][data-state="withheld"]')).not.toBeNull();
    const clickRetry = async () => {
      await act(async () => { retry().focus(); retry().click(); });
      await runtime.settle();
    };
    try {
      await render();
      const first = await nextRead(1);
      safe();
      expect(status().textContent).toContain('Reading your preferences');
      first.work.resolve({ status: 503, error: { code: 'unavailable' }, headers: new Headers() });
      await runtime.settle();
      expect(status().textContent).toContain('unavailable');
      safe();
      const publicLink = host.querySelector<HTMLAnchorElement>('a[href*="/@mira"]')!;
      expect(publicLink).not.toBeNull();
      const recovery = host.querySelector('[data-slot="contribution-return-recovery"]');
      if (view === 'posts') expect(recovery).not.toBeNull();
      const trigger = retry();
      await clickRetry();
      const recovered = await nextRead(2);
      safe();
      expect(retry()).toBe(trigger);
      expect(retry().getAttribute('aria-disabled')).toBe('true');
      // Moving focus while retry is pending must win over its completion.
      publicLink.focus();
      recovered.work.resolve(runtime.result('show'));
      await runtime.settle();
      expect(status().textContent).toContain('preferences are applied');
      expect(host.querySelector('[data-slot="cover"][data-state="withheld"]')).toBeNull();
      expect(window.document.activeElement).toBe(publicLink);
      expect(host.querySelector('[data-slot="contribution-return-recovery"]')).toBe(recovery);
      expect(JSON.stringify(page.reads)).toBe(publicReads);
      // A successful cautious preference value still means personalized reading.
      await clickRetry();
      const cautious = await nextRead(3);
      safe();
      cautious.work.resolve(runtime.result('blur'));
      await runtime.settle();
      expect(status().textContent).toContain('preferences are applied');
      expect(window.document.activeElement).toBe(trigger);
      safe();
      const reveal = host.querySelector<HTMLButtonElement>('[data-slot="cover"] button')!;
      expect(reveal).not.toBeNull();
      await act(async () => reveal.click());
      await clickRetry();
      const failedRetry = await nextRead(4);
      safe(); // Explicit content reveals retire with the response, even before the new read completes.
      failedRetry.work.resolve({ status: 503, error: { code: 'unavailable' }, headers: new Headers() });
      await runtime.settle();
      safe();
      expect(status().textContent).toContain('unavailable');
      await clickRetry();
      const retired = await nextRead(5);
      await act(async () => {
        runtime.setReader('reader-b');
        client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-b', csrfToken: 'new' });
      });
      const replacement = await nextRead(6);
      retired.work.resolve(runtime.result('show'));
      await runtime.settle();
      safe();
      replacement.work.resolve(runtime.result('blur'));
      await runtime.settle();
      expect(status().textContent).toContain('preferences are applied');
      safe();
      // Native prepared identity, rather than browser intent, decides whether a response matches.
      runtime.setReader('reader-a');
      await clickRetry();
      const mismatch = await nextRead(7);
      mismatch.work.resolve(runtime.result('show'));
      await runtime.settle();
      safe();
      expect(status().textContent).toContain('do not match');
      runtime.setReader('reader-b');
      await clickRetry();
      const lateRoute = await nextRead(8);
      handle = 'other'; locale = 'fr';
      await render();
      const currentRoute = await nextRead(9);
      lateRoute.work.resolve(runtime.result('show'));
      await runtime.settle();
      safe();
      currentRoute.work.resolve(runtime.result('blur'));
      await runtime.settle();
      safe();
      // Existing return recovery survives preference updates for missing rows in both populated and empty lists.
      if (view === 'posts') {
        rememberContribution('missing-row', '/en/threads/missing#post-missing', window as unknown as Window);
        await clickRetry();
        const beforeEmpty = await nextRead(10);
        const oldPage = page;
        page = fixtures.contributionPage('posts');
        for (const read of Object.values(page.reads)) {
          if (read.body && typeof read.body === 'object' && 'posts' in read.body)
            (read.body as { posts: unknown[] }).posts = [];
        }
        await render();
        const emptyReading = await nextRead(11);
        beforeEmpty.work.resolve(runtime.result('show'));
        emptyReading.work.resolve(runtime.result('blur'));
        await runtime.settle();
        expect(page).not.toBe(oldPage);
        const notice = host.querySelector<HTMLElement>('[data-slot="contribution-return-recovery"]')!;
        expect(notice).not.toBeNull();
        expect(notice.hidden).toBe(false);
        expect(window.location.href).toBe('https://rezics.test/en/@mira/posts?cursor=a%2Bb#reading');
      }
      await clickRetry();
      const pending = await nextRead(view === 'posts' ? 12 : 10);
      enabled = false;
      await render();
      pending.work.resolve(runtime.result('show'));
      await runtime.settle();
      expect(host.textContent).toBe('Public page unavailable');
      expect(client.getQueryCache().findAll({ queryKey: ['agent-reader'] }).every((query) => !query.state.data)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      await runtime.settle();
      client.clear();
      restore();
    }
  });
}
