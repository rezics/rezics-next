import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { ThreadWatch } from '../threads/thread-watch';
import { createThreadWatchNative, readNativeThreadWatch, setNativeThreadWatch } from '../threads/thread-watch-native';
import { ThreadReadingHeader } from '../routes/threads/$id_.$slug';
import type { ThreadReadingPage } from '../threads/thread-reading';
import recordedThread from '../kernel/recorded/thread.json';
import recordedPosts from '../kernel/recorded/thread-posts.json';

type Example = 'not-watching' | 'watching' | 'initial-failure' | 'pending' | 'refusal' |
  'unknown' | 'access-lost' | 'anonymous' | 'session-replacement';

const page = {
  thread: recordedThread.thread,
  posts: recordedPosts,
  subjects: [], provenanceSubjects: [], authors: {}, mentions: {},
  verification: { sitekey: '', scriptUrl: '' }, now: '2026-10-24T00:00:00Z',
} as ThreadReadingPage;

/** Prepared wire responses pass through the installed generated client and the production outcome mapping. */
function connectedExample(example: Example) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const anonymous = example === 'anonymous';
  const session = (token: string) => ({ state: 'signed-in', subject: 'reader-example', csrfToken: token });
  client.setQueryData(['session'], anonymous ? { state: 'signed-out', subject: null, csrfToken: null } : session('A'.repeat(22)));
  let watching = example === 'watching';
  let reads = 0;
  let commands = 0;
  const kernel = createKernelClient('https://kernel.story.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        reads++;
        if (example === 'access-lost') return Response.json({ code: 'forbidden' }, { status: 403 });
        if (example === 'initial-failure' && reads === 1) throw new TypeError('Prepared failed read');
        return Response.json({ watching });
      }
      commands++;
      if (example === 'pending') return new Promise<Response>(() => {});
      if (example === 'refusal') return Response.json({ code: 'rate_limited' }, { status: 429 });
      if (example === 'unknown' && commands === 1) throw new TypeError('Prepared lost response');
      if (example === 'session-replacement' && commands === 1) {
        client.setQueryData(['session'], session('B'.repeat(22)));
        await Promise.resolve();
        // This response belongs to the old visit, even if the account remains the same.
        return new Response(null, { status: 204 });
      }
      watching = request.method === 'PUT';
      return new Response(null, { status: 204 });
    },
  });
  const native = createThreadWatchNative(async () => ({
    readThreadWatch: ({ data }) => readNativeThreadWatch(kernel, data.threadId, 'Bearer prepared-reader'),
    setThreadWatch: ({ data }) => setNativeThreadWatch(kernel, data.threadId, data.watching, 'Bearer prepared-reader'),
  }));
  return { client, native, anonymous };
}

function ThreadWatchPageStory({ example }: { example: Example }) {
  const model = useMemo(() => connectedExample(example), [example]);
  return (
    <QueryClientProvider client={model.client}>
      <main className="mx-auto max-w-3xl space-y-5 p-4">
        <ThreadReadingHeader
          page={page}
          title={page.thread.title}
          watch={
            <ThreadWatch
              threadId={page.thread.id}
              session={model.anonymous ? 'signed-out' : 'signed-in'}
              sessionKnown
              viewerId={model.anonymous ? undefined : 'reader-example'}
              sessionStamp="story-admission"
              admitted
              readAuthority={model}
              returnTo={`/threads/${page.thread.id}/letters-from-b-612`}
              native={model.native}
            />
          }
        />
        <article className="space-y-3">
          <h2 className="text-lg font-medium">Opening post</h2>
          <p>The conversation stays readable while your private watch setting is checked or recovered.</p>
        </article>
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Pages/Community/Thread watch',
  component: ThreadWatchPageStory,
  parameters: {
    viewport: {
      defaultViewport: 'phone390',
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: { description: { component: 'Connected header and browser-session examples use prepared GET {watching} and PUT/DELETE 204 responses through the generated client. Native execution is verified separately.' } },
  },
} satisfies Meta<typeof ThreadWatchPageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotWatching: Story = {
  args: { example: 'not-watching' },
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await canvas.findByText(m.thread_watch_confirm_started());
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_stop() }));
    await canvas.findByText(m.thread_watch_confirm_stopped());
  },
};
export const Watching: Story = {
  args: { example: 'watching' },
  globals: { locale: 'de', theme: 'dark', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => { await within(canvasElement).findByRole('button', { name: m.thread_watch_stop() }); },
};
export const InitialFailure: Story = {
  args: { example: 'initial-failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_check_again() }));
    await canvas.findByRole('button', { name: m.thread_watch_watch() });
  },
};
export const Pending: Story = {
  args: { example: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await expect(await canvas.findByRole('button', { name: m.thread_watch_retry_exact() })).toBeDisabled();
  },
};
export const Refusal: Story = {
  args: { example: 'refusal' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await canvas.findByText(m.thread_watch_unavailable());
    await canvas.findByRole('button', { name: m.thread_watch_check_again() });
  },
};
export const UnknownOutcome: Story = {
  args: { example: 'unknown' },
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await canvas.findByRole('button', { name: m.thread_watch_check_again() });
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_retry_exact() }));
    await canvas.findByText(m.thread_watch_confirm_started());
  },
};
export const SessionReplacement: Story = {
  args: { example: 'session-replacement' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await canvas.findByRole('button', { name: m.thread_watch_watch() });
    await expect(canvas.queryByText(m.thread_watch_confirm_started())).toBeNull();
  },
};
export const AccessLost: Story = {
  args: { example: 'access-lost' },
  globals: { locale: 'ja', theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => { await within(canvasElement).findByText(m.thread_watch_access_lost()); },
};
export const AnonymousReader: Story = {
  args: { example: 'anonymous' },
  globals: { locale: 'es', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => { await within(canvasElement).findByText(m.thread_watch_anonymous()); },
};
export const French: Story = { args: { example: 'not-watching' }, globals: { locale: 'fr', theme: 'dark' } };
export const Korean: Story = { args: { example: 'watching' }, globals: { locale: 'ko', theme: 'light' } };
export const SimplifiedChinese: Story = { args: { example: 'not-watching' }, globals: { locale: 'zh-Hans', theme: 'dark' } };
export const GermanPhone: Story = {
  args: { example: 'watching' },
  globals: { locale: 'de', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
};
export const SpanishDesktop: Story = {
  args: { example: 'not-watching' },
  globals: { locale: 'es', theme: 'dark', viewport: { value: 'desktop1280', isRotated: false } },
};
export const JapanesePhone: Story = {
  args: { example: 'watching' },
  globals: { locale: 'ja', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
};
export const TraditionalChineseDesktop: Story = {
  args: { example: 'not-watching' },
  globals: { locale: 'zh-Hant', theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
};
