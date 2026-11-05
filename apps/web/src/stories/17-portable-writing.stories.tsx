import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useLayoutEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { fromPlainText, type DocumentNode } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { PostComposer } from '../threads/composer';
import {
  PortableWritingControls,
  PortableWritingToolbar,
  usePortableWriting,
} from '../threads/portable-writing-controls';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';

type Scenario = 'writing' | 'unknown' | 'raw';
type Props = { width: number; dark: boolean; long: boolean; scenario: Scenario };
const session = {
  state: 'signed-in' as const,
  subject: 'prepared-writer',
  csrfToken: 'prepared-current-visit-session',
};
const imported = '**Imported rich writing**\n\nA second paragraph. 漢字と文章。';

/** A visible prepared snapshot failure exercises the recovery UI without claiming native failure evidence. */
function PreparedRawRecovery() {
  const [owner] = useState(() => new AbortController());
  const host = useRef<HTMLDivElement>(null);
  const raw: DocumentNode = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Prepared unnormalizable editor work' }] }],
  };
  const transfer = usePortableWriting(
    {
      current: () => !owner.signal.aborted,
      signal: owner.signal,
      revision: () => 0,
      replaceable: () => true,
      snapshot: () => ({ body: fromPlainText('Last valid body', 'blocks'), phase: 'failed', raw }),
      replace: () => undefined,
      focus: () => host.current?.focus(),
    },
    true,
  );
  return (
    <div>
      <p className="mb-4 text-sm">Prepared editor snapshot failure; this is not native acceptance evidence.</p>
      <div ref={host} role="textbox" aria-label="Prepared raw editor" tabIndex={0} className="rounded-xl border p-4">
        Prepared unnormalizable editor work
      </div>
      {transfer ? (
        <>
          <PortableWritingToolbar transfer={transfer} />
          <PortableWritingControls transfer={transfer} signal={owner.signal} disabled={false} phase="failed" />
        </>
      ) : null}
    </div>
  );
}

function PreparedJourney({ width, dark, long, scenario }: Props) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    value.setQueryData(sessionQuery.queryKey, session);
    return value;
  });
  const [result, setResult] = useState('Prepared local-file journey. Submission responses are supplied fixtures.');
  const [epoch, setEpoch] = useState(0);
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => (
        <PostComposer
          initialKey="prepared-original-command"
          containerId="prepared-thread"
          initialBody={fromPlainText(
            long ? 'Original unsent writing with long words and 日本語. '.repeat(160) : 'Original unsent writing.',
            'blocks',
          )}
          onSubmit={async () => {
            setResult(
              scenario === 'unknown'
                ? 'Prepared unknown outcome: only the original exact retry remains.'
                : 'Prepared confirmed submission through the original composer.',
            );
            return scenario === 'unknown'
              ? { ok: false, reason: 'unavailable' }
              : { ok: true, value: 'prepared-confirmed' };
          }}
          onSuccess={() => undefined}
        />
      ),
    });
    return createRouter({
      routeTree: root.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  });
  useLayoutEffect(
    () => () => {
      client.clear();
    },
    [client],
  );
  return (
    <main
      className={`${dark ? 'dark' : ''} min-h-screen bg-background text-foreground`}
      style={{ width, maxWidth: '100%' }}
    >
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
        <p role="status" className="text-sm">
          {result}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 whitespace-normal"
            onClick={() => {
              client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
              client.setQueryData(sessionQuery.queryKey, session);
            }}
          >
            Prepared account away/back
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 whitespace-normal"
            onClick={() => setEpoch((value) => value + 1)}
          >
            Prepared route replacement
          </Button>
        </div>
        <QueryClientProvider client={client}>
          {scenario === 'raw' ? <PreparedRawRecovery key={epoch} /> : <RouterProvider key={epoch} router={router} />}
        </QueryClientProvider>
      </div>
    </main>
  );
}
const meta = {
  title: 'Pages/Community/Portable Writing',
  component: PreparedJourney,
  args: { width: 390, dark: false, long: false, scenario: 'writing' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Prepared local files and command outcomes. Existing Post Editor and Browser Writing Recovery stories retain formatting, upload, departure and reload coverage.',
      },
    },
  },
} satisfies Meta<typeof PreparedJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
const choose = async (view: ReturnType<typeof within>, source = imported, name = 'local.md') => {
  await userEvent.upload(
    view.getByLabelText(m.thread_portable_choose(), { selector: 'input' }),
    new File([source], name, { type: 'text/plain' }),
  );
};
const journey: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
  await choose(view);
  await view.findByRole('heading', { name: m.thread_portable_preview() });
  await expect(view.getByRole('textbox', { name: m.thread_reply_label() })).toHaveTextContent(
    'Original unsent writing.',
  );
  await userEvent.click(view.getByRole('button', { name: m.thread_portable_keep() }));
  await choose(view);
  await userEvent.click(await view.findByRole('button', { name: m.thread_portable_replace() }));
  const editor = view.getByRole('textbox', { name: m.thread_reply_label() });
  await expect(editor).toHaveFocus();
  await expect(editor.querySelector('strong')).toHaveTextContent('Imported rich writing');
  await userEvent.click(view.getByRole('button', { name: m.thread_portable_export_json() }));
  const exported = view.getByRole('textbox', { name: m.thread_portable_copy_hint() });
  await expect(exported).toHaveFocus();
  await expect((exported as HTMLTextAreaElement).value).toContain('bold');
  await userEvent.click(view.getByRole('button', { name: m.thread_portable_export_text() }));
  await expect(view.getByRole('textbox', { name: m.thread_portable_copy_hint() })).toHaveValue(
    'Imported rich writing\nA second paragraph. 漢字と文章。',
  );
  await userEvent.keyboard('{Escape}');
  await expect(editor).toHaveFocus();
  await userEvent.click(view.getByRole('button', { name: m.thread_write_send() }));
  await view.findByText('Prepared confirmed submission through the original composer.');
};
export const PhoneLightJourney: Story = { play: journey };
export const PhoneDarkJourney: Story = { args: { dark: true }, play: journey };
export const DesktopLightJourney: Story = { args: { width: 1280 }, play: journey };
export const DesktopDarkJourney: Story = { args: { width: 1280, dark: true }, play: journey };
export const LongWritingKeyboardKeep: Story = {
  args: { long: true, dark: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await choose(view, '# Long imported writing\n\n' + 'Long translation text 日本語. '.repeat(240));
    const keep = await view.findByRole('button', { name: m.thread_portable_keep() });
    keep.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByRole('textbox', { name: m.thread_reply_label() })).toHaveFocus();
    await expect(view.queryByRole('heading', { name: m.thread_portable_preview() })).not.toBeInTheDocument();
  },
};
export const EditedPreviewIsInvalid: Story = {
  args: { width: 1280 },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await choose(view);
    await view.findByRole('heading', { name: m.thread_portable_preview() });
    await userEvent.click(view.getByRole('textbox', { name: m.thread_reply_label() }));
    await userEvent.keyboard(' A later edit.');
    await view.findByText(m.thread_portable_error_changed());
    await expect(view.queryByRole('button', { name: m.thread_portable_replace() })).not.toBeInTheDocument();
  },
};
export const MediaRepairAndInvalidJSON: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await choose(view, '![Description retained](https://foreign.invalid/private.png)', 'image.md');
    await view.findByText(m.thread_portable_attachments({ count: 1 }));
    await expect(canvasElement.querySelector('[data-private-writing] img')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.thread_portable_keep() }));
    await choose(view, '{bad-json', 'invalid.json');
    await view.findByText(m.thread_portable_error_json());
  },
};
export const UnknownKeepsExactCustody: Story = {
  args: { scenario: 'unknown', width: 1280, dark: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await userEvent.click(view.getByRole('button', { name: m.thread_write_send() }));
    await view.findByText('Prepared unknown outcome: only the original exact retry remains.');
    await expect(view.getByRole('button', { name: m.thread_portable_choose() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.thread_write_retry() })).toBeEnabled();
    await userEvent.click(view.getByRole('button', { name: m.thread_portable_export_text() }));
    await expect(view.getByRole('textbox', { name: m.thread_portable_copy_hint() })).toHaveValue(
      'Original unsent writing.',
    );
  },
};
export const RawRecoveryIsDistinct: Story = {
  args: { scenario: 'raw' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await expect(view.getByRole('button', { name: m.thread_portable_export_json() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.thread_portable_export_raw() }));
    await expect(
      (view.getByRole('textbox', { name: m.thread_portable_copy_hint() }) as HTMLTextAreaElement).value,
    ).toContain('unnormalized-editor-work');
  },
};
export const AccountRetiresPreview: Story = {
  args: { dark: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_portable_files() }));
    await choose(view);
    await view.findByRole('heading', { name: m.thread_portable_preview() });
    await userEvent.click(view.getByRole('button', { name: 'Prepared account away/back' }));
    await waitFor(() =>
      expect(view.queryByRole('heading', { name: m.thread_portable_preview() })).not.toBeInTheDocument(),
    );
    await view.findByText(m.thread_authoring_session_changed());
  },
};
