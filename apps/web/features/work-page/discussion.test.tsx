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
