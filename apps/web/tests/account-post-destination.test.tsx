import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { contributionPage } from '../src/stories/pages/accounts-public-profile/fixtures';
import recording from '../src/kernel/recorded/agent-page-reader.json';
import { subjectPageMessages } from '../src/features/pages/route-support';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage } = await import('../src/features/pages/subject');

test('account post rows select their disclosed posts in localized canonical threads, including untitled threads', () => {
  for (const locale of ['en', 'zh-Hant']) {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SubjectPage page={contributionPage()} locale={locale} messages={subjectPageMessages()} renderJsonLd={false} />
      </QueryClientProvider>,
    );
    expect([...html.matchAll(/href="([^"]*\?post=[^"]+)"/g)].map((match) => match[1])).toEqual(
      recording.reads.r11.body.posts.map(
        (post, index) =>
          `/${locale}/threads/${post.threadId}/${index === 2 ? 'thread' : `reading-group-week-${index + 1}`}?post=${post.id}#post-${post.id}`,
      ),
    );
    expect(html).toContain(
      `href="/${locale}/threads/${recording.reads.r12.body.threads[0]!.id}/review-1-a-quiet-read"`,
    );
  }
});
