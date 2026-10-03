import { expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import Link from '../features/shell/localized-link.tsx';
import { ShellProvider } from '../features/shell/shell-provider.tsx';
import { messages } from '../features/shell/messages.ts';

test('G1030: SSR type links carry their full locale, conditions and destination before any handlers exist', () => {
  const html = renderToString(
    <ShellProvider
      locale="zh-Hant"
      messages={messages}
      initialTheme="light"
      initialCollapsed={false}
    >
      <Link
        href="/discover?tab=works&q=雨#results"
        aria-current="page"
        prefetch={false}
        scroll={false}
      >
        作品
      </Link>
    </ShellProvider>,
  );
  expect(html).toContain(
    '<a href="/zh-Hant/discover?tab=works&amp;q=雨#results" aria-current="page">作品</a>',
  );
  expect(html).not.toContain('prefetch=');
  expect(html).not.toContain('scroll=');
});

test('G1030: native navigation retains external links, downloads and the displayed alias', () => {
  const html = renderToString(
    <>
      <Link href="https://client.test/callback?state=kept" target="_blank" rel="noreferrer">
        Client
      </Link>
      <Link href="/export/data.json" download>
        Export
      </Link>
      <Link href="/discover" as="/zh-Hant/discover?tab=works">
        Readers
      </Link>
    </>,
  );
  expect(html).toContain('href="https://client.test/callback?state=kept"');
  expect(html).toContain('target="_blank" rel="noreferrer"');
  expect(html).toContain('href="/export/data.json" download=""');
  expect(html).toContain('href="/zh-Hant/discover?tab=works"');
});
