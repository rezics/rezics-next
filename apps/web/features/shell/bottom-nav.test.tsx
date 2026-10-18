import { afterEach, expect, test } from 'bun:test';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { renderToString } from 'react-dom/server';
import { uiLocales } from '../../i18n/define.ts';
import { BottomNav } from './bottom-nav.tsx';
import { messages } from './messages.ts';
import { navigation } from './navigation.ts';
import { ShellProvider } from './shell-provider.tsx';
import { setUnread } from './unread.ts';

afterEach(() => setUnread(null));

for (const locale of uiLocales) {
  for (const signedIn of [false, true]) {
    test(`phone navigation names contain their visible ${locale} captions, signed in: ${signedIn}`, () => {
      // A cached count from another page must not leak into an anonymous server render.
      setUnread({ count: 3, overflow: false });
      const html = renderToString(<PathnameContext value={`/${locale}/discover`}>
        <ShellProvider locale={locale} messages={messages} initialTheme="light" initialCollapsed={false} signedIn={signedIn}>
          <BottomNav />
        </ShellProvider>
      </PathnameContext>);
      const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      const items = navigation.filter(item => item.bottom);
      expect(links).toHaveLength(items.length);
      items.forEach((item, index) => {
        const [, attributes, contents] = links[index]!;
        const caption = item.bottomLabel?.[locale] ?? item.label[locale];
        const name = attributes!.match(/\baria-label="([^"]*)"/)?.[1]
          ?? contents!.replace(/<[^>]*>/g, '');
        expect(name).toContain(caption);
        expect(contents).toContain(caption);
        expect(attributes).toContain(`href="/${locale}${item.href === '/' ? '' : item.href}"`);
        if (item.href === '/discover') expect(attributes).toContain('aria-current="page"');
      });
      expect(html).not.toContain('3 unread');
    });
  }
}
