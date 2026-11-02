import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadMyPublishedLogs } from '../src/library/logs-read';
import { MyLogsPageView } from '../src/library/my-logs-page';
import { myLogsSearch } from '../src/library/my-logs';
import { m } from '../src/paraglide/messages.js';

test('malformed published-log positions render a localized newest link and cannot become a reader request', async () => {
  const malformed = ['', 'a'.repeat(4097), ['repeated']];
  for (const cursor of malformed) expect(myLogsSearch({ cursor })).toEqual({ invalidPosition: true });
  expect(myLogsSearch({ cursor: 'signed+/opaque=' })).toEqual({ cursor: 'signed+/opaque=' });

  let reads = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => {
      reads++;
      throw new Error('Malformed position reached the published-log reader');
    },
  });
  for (const cursor of malformed.slice(0, 2))
    await expect(
      loadMyPublishedLogs(client, new Request('https://site.test/en/library/logs'), {}, { cursor: cursor as string }),
    ).rejects.toThrow('Invalid published log cursor');
  expect(reads).toBe(0);

  const html = renderToStaticMarkup(createElement(MyLogsPageView, { page: { state: 'invalid-position' } }));
  expect(html).toContain(m.library_my_logs_invalid_position());
  expect(html).toContain('href="/en/library/logs"');
});
