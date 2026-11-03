import { afterAll, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { ShellTopActions } = await import('../src/shell/top-bar');
const { m } = await import('../src/paraglide/messages.js');
afterAll(() => mock.restore());

test('restoring and failed account states are distinct and neither discloses account controls', () => {
  const render = (session: 'unknown' | 'unavailable') =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ShellTopActions
          session={session}
          pathname="/"
          returnTo="/en"
          account={<button>Private account</button>}
          unread={{ signedIn: true, state: 'ready', count: 23, capped: false }}
        />
      </QueryClientProvider>,
    );
  const loading = render('unknown');
  const failed = render('unavailable');
  expect(loading).toContain('aria-busy="true"');
  expect(loading).toContain(m.candidate_loading());
  expect(failed).toContain(m.shell_account_unavailable());
  expect(failed).not.toContain('aria-busy="true"');
  for (const markup of [loading, failed]) {
    expect(markup).not.toContain('Private account');
    expect(markup).not.toContain('23 unread');
    expect(markup).not.toContain('href="/en/inbox"');
  }
});
