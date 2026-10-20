import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiscussionPage } from './types.ts';
import { messages as feedMessages } from '../feed/messages.ts';
import { messages as workMessages } from './messages.ts';
import { discussion } from './fixtures.ts';
import { DiscussionList } from './discussion.tsx';

test('Work discussion cards keep marked words out of accessible text and leave unmarked words visible', () => {
  const [markedReply, unmarkedReply] = discussion.ok ? discussion.data.items : [];
  const items: DiscussionPage['items'] = [
    { ...markedReply!, body: 'The city sinks in the final chapter.', spoiler: true },
    { ...unmarkedReply!, body: 'The cartographer is an unreliable narrator.', spoiler: false },
  ];
  const html = renderToStaticMarkup(createElement(DiscussionList, { items, locale: 'en',
    messages: workMessages.en, feedMessages, realmLabel: () => 'Tidewater Readers' }));

  expect(html).toContain('The author marked this as a spoiler.');
  expect(html).toContain('Show spoiler');
  expect(html).not.toContain('The city sinks in the final chapter.');
  expect(html).toContain('The cartographer is an unreliable narrator.');
});

test.each([false, true])('native post and reply ownership survives identical text and reversed order (%s)', reverse => {
  const [first, second] = discussion.ok ? discussion.data.items : [];
  const items: DiscussionPage['items'] = [
    { ...first!, kind: 'reply', body: 'The same public discussion text.', spoiler: false },
    { ...second!, kind: 'post', body: 'The same public discussion text.', spoiler: false },
  ];
  if (reverse) items.reverse();
  const html = renderToStaticMarkup(createElement(DiscussionList, { items, locale: 'en',
    messages: workMessages.en, realmLabel: () => 'Tidewater Readers' }));
  const rows = [...html.matchAll(/<li\b[^>]*data-discussion-object="[^"]*"[^>]*>.*?<\/li>/gs)]
    .map(match => match[0]);

  expect(rows).toHaveLength(2);
  for (const [index, item] of items.entries()) {
    const row = rows[index]!;
    expect(row).toContain(`data-discussion-object="${item.kind}"`);
    expect(row).toContain(`data-resource="${item.reply}"`);
    expect(row).toContain(`id="${item.reply.slice(-36)}"`);
    expect(row).toContain(`aria-label="More actions for ${item.kind}"`);
    expect(row.match(/<button\b/g)).toHaveLength(1);
    expect(row).toContain(item.body);
    expect(row).toMatch(/<time\b/);
    expect(row).toContain('View in thread');
    expect(row).not.toContain('data-report-action=');
  }
});

test('discussion overflow labels use the supplied locale for both native roles', () => {
  const [first, second] = discussion.ok ? discussion.data.items : [];
  const items: DiscussionPage['items'] = [
    { ...first!, kind: 'post' },
    { ...second!, kind: 'reply' },
  ];
  const html = renderToStaticMarkup(createElement(DiscussionList, { items, locale: 'zh-Hans',
    messages: workMessages['zh-Hans'], realmLabel: () => 'Tidewater Readers' }));

  expect(html).toContain('aria-label="帖子的更多操作"');
  expect(html).toContain('aria-label="回复的更多操作"');
  expect(html).not.toContain('More actions for');
  expect(html).not.toContain('data-report-action=');
});
