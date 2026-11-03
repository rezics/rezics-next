import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { m } from '../paraglide/messages.js';
import { ThreadWatch } from '../threads/thread-watch';
import type { ThreadWatchCommand, ThreadWatchNative, ThreadWatchReadRequest } from '../threads/thread-watch-native';

type Example = 'not-watching' | 'watching' | 'unknown' | 'access-lost' | 'anonymous';
type Trace = { reads: ThreadWatchReadRequest[]; commands: ThreadWatchCommand[] };
const traces = new Map<Example, Trace>();

function illustratedResponses(example: Example): ThreadWatchNative {
  const trace = { reads: [] as ThreadWatchReadRequest[], commands: [] as ThreadWatchCommand[] };
  traces.set(example, trace);
  return {
    async read(request) {
      trace.reads.push(request);
      if (example === 'access-lost') return { kind: 'access-lost' };
      return {
        kind: 'confirmed',
        state: { watching: example === 'watching', revision: `illustration-${example}` },
      };
    },
    async set(command) {
      trace.commands.push(command);
      if (example === 'unknown') throw new Error('Illustrative response was lost');
      return { kind: 'confirmed', state: { watching: command.watching, revision: 'illustration-next' } };
    },
  };
}

function ThreadWatchPageStory({ example }: { example: Example }) {
  const native = useMemo(() => illustratedResponses(example), [example]);
  const anonymous = example === 'anonymous';
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">A readable thread</h1>
        <ThreadWatch
          threadId="thread-example"
          session={anonymous ? 'signed-out' : 'signed-in'}
          sessionKnown
          viewerId={anonymous ? undefined : 'reader-example'}
          sessionStamp="story-session"
          admitted
          returnTo="/threads/thread-example/readable-thread"
          native={native}
        />
      </header>
      <article className="space-y-3">
        <h2 className="text-lg font-medium">Opening post</h2>
        <p>The discussion remains readable while the private watch state is checked separately.</p>
      </article>
    </main>
  );
}

const meta = {
  title: 'Pages/Threads/Watch',
  component: ThreadWatchPageStory,
  parameters: {
    viewport: {
      defaultViewport: 'phone390',
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'The installed route stays unavailable until Content delivers generated watch reads and commands. Local responses below illustrate the Web states and are not native evidence.',
      },
    },
  },
} satisfies Meta<typeof ThreadWatchPageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotWatching: Story = {
  args: { example: 'not-watching' },
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('button', { name: m.thread_watch_watch() });
    await expect(traces.get('not-watching')?.reads[0]?.threadId).toBe('thread-example');
  },
};

export const Watching: Story = {
  args: { example: 'watching' },
  globals: { locale: 'de', theme: 'dark', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('button', { name: m.thread_watch_stop() });
  },
};

export const UnknownOutcome: Story = {
  args: { example: 'unknown' },
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.thread_watch_watch() }));
    await canvas.findByRole('button', { name: m.thread_watch_retry_exact() });
    await expect(traces.get('unknown')?.commands).toHaveLength(1);
  },
};

export const AccessLost: Story = {
  args: { example: 'access-lost' },
  globals: { locale: 'ja', theme: 'light', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.thread_watch_access_lost());
    await expect(traces.get('access-lost')?.reads).toHaveLength(1);
    await expect(traces.get('access-lost')?.commands).toHaveLength(0);
  },
};

export const AnonymousReader: Story = {
  args: { example: 'anonymous' },
  globals: { locale: 'es', theme: 'light', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.thread_watch_anonymous());
    await expect(traces.get('anonymous')?.reads).toHaveLength(0);
    await expect(traces.get('anonymous')?.commands).toHaveLength(0);
  },
};

export const French: Story = { args: { example: 'not-watching' }, globals: { locale: 'fr', theme: 'dark' } };
export const Korean: Story = { args: { example: 'watching' }, globals: { locale: 'ko', theme: 'light' } };
export const SimplifiedChinese: Story = {
  args: { example: 'not-watching' },
  globals: { locale: 'zh-Hans', theme: 'dark' },
};
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
