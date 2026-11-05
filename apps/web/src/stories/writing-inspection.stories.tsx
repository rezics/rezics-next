import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
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
import { fromPlainText, normalizeDocument, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import {
  WritingInspectionControls,
  WritingInspectionToolbar,
  useWritingInspection,
} from '../threads/writing-inspection-controls';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';

type Scenario = 'writing' | 'long' | 'empty' | 'pending' | 'unsupported' | 'changed' | 'account' | 'unknown';
type Caller = 'new-thread' | 'reply' | 'edit';
type Props = { width: number; dark: boolean; caller: Caller; scenario: Scenario };
const session = {
  state: 'signed-in' as const,
  subject: 'prepared-inspection-writer',
  csrfToken: 'prepared-current-visit',
};
const mediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000088';

function fixtureBody(scenario: Scenario): DocumentSnapshot {
  if (scenario === 'empty') return fromPlainText('', 'blocks');
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: withDocumentIds({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'A current unsent thought · 今の文章' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text:
                scenario === 'long'
                  ? '日本語、繁體中文、简体中文、한국어. e\u0301 👩🏽‍💻 — Eine lange Überlegung. Une réflexion. Una reflexión. '.repeat(
                      120,
                    )
                  : 'The current draft stays here. 日本語 e\u0301 👩🏽‍💻',
            },
          ],
        },
        ...(scenario === 'pending'
          ? [{ type: 'image', attrs: { src: `/media/${mediaId}/original`, alt: 'Prepared pending attachment' } }]
          : []),
      ],
    }),
  });
}

/** These two states exercise the installed optional snapshot port, not a second editor engine. */
function PreparedSnapshotPort({ scenario }: { scenario: 'unsupported' | 'changed' }) {
  const [owner] = useState(() => new AbortController());
  const [body, setBody] = useState(() => fixtureBody('writing'));
  const revision = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const inspection = useWritingInspection({
    signal: owner.signal,
    binding: 'prepared-port',
    current: () => !owner.signal.aborted,
    revision: () => revision.current,
    snapshot: () => ({ body, phase: scenario === 'unsupported' ? 'failed' : 'ready' }),
    title: () => null,
    facts: () => ({ pendingUploads: 0, attachmentIssues: [], refusal: null, sending: false, unknown: false }),
    editor: () => host.current?.querySelector<HTMLElement>('.ProseMirror') ?? null,
  });
  useLayoutEffect(() => () => owner.abort(), [owner]);
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm">Prepared snapshot-port state. The original editor retains all writing.</p>
      <div ref={host}>
        <RichTextEditor
          value={body}
          label="Prepared current editor"
          onChange={(next) => {
            revision.current++;
            setBody(next);
            inspection?.changed();
          }}
        />
      </div>
      {inspection ? (
        <>
          <WritingInspectionToolbar inspection={inspection} />
          <WritingInspectionControls
            inspection={inspection}
            context={
              scenario === 'changed' ? (
                <Button
                  type="button"
                  className="min-h-11 whitespace-normal"
                  onClick={() => {
                    revision.current++;
                    setBody(fromPlainText('Prepared newer current writing', 'blocks'));
                    inspection.changed();
                  }}
                >
                  Prepared background editor transaction
                </Button>
              ) : undefined
            }
          />
        </>
      ) : null}
    </div>
  );
}

function PreparedJourney({ width, dark, caller, scenario }: Props) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    value.setQueryData(sessionQuery.queryKey, session);
    return value;
  });
  const [result, setResult] = useState('Prepared authoring responses; inspection itself performs no requests.');
  const [body] = useState(() => fixtureBody(scenario));
  useLayoutEffect(() => {
    if (scenario !== 'pending') return;
    const original = window.fetch;
    window.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const href = input instanceof Request ? input.url : String(input);
        if (new URL(href, window.location.origin).pathname === `/media/${mediaId}/original`) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
              once: true,
            });
          });
        }
        return original.call(window, input, init);
      },
      { preconnect: original.preconnect },
    );
    return () => {
      window.fetch = original;
    };
  }, [scenario]);
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () =>
        caller === 'edit' ? (
          <InlinePostEditor
            initialBody={body}
            revisionId="prepared-source-revision"
            idempotencyKey="prepared-edit-command"
            containerId="prepared-thread"
            onCancel={() => setResult('Prepared cancel through the original editor.')}
            onSubmit={async () => {
              setResult('Prepared unknown result; the original immutable command owns recovery.');
              return { ok: false, reason: 'unavailable' };
            }}
            onSuccess={() => undefined}
          />
        ) : (
          <PostComposer
            initialBody={body}
            initialKey="prepared-original-command"
            titleRequired={caller === 'new-thread'}
            {...(caller === 'new-thread'
              ? { boardId: 'prepared-board' }
              : { containerId: 'prepared-thread', replyTargetId: 'prepared-parent' })}
            onSubmit={async () => {
              setResult(
                scenario === 'unknown'
                  ? 'Prepared unknown result; exact original retry remains.'
                  : 'Prepared deliberate original Send.',
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
  useLayoutEffect(() => () => client.clear(), [client]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.classList.contains('dark');
    root.classList.toggle('dark', dark);
    return () => {
      root.classList.toggle('dark', previous);
    };
  }, [dark]);
  return (
    <main
      className={`${dark ? 'dark' : ''} min-h-screen bg-background text-foreground`}
      style={{ width, maxWidth: '100%' }}
    >
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-8">
        <p role="status" className="text-sm">
          {result}
        </p>
        {scenario === 'account' ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 whitespace-normal"
            onClick={() => {
              client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
              client.setQueryData(sessionQuery.queryKey, session);
            }}
          >
            Prepared account replacement and return
          </Button>
        ) : null}
        <QueryClientProvider client={client}>
          {scenario === 'unsupported' || scenario === 'changed' ? (
            <PreparedSnapshotPort scenario={scenario} />
          ) : (
            <RouterProvider router={router} />
          )}
        </QueryClientProvider>
      </div>
    </main>
  );
}

const meta = {
  title: 'Pages/Community/Writing Inspection',
  component: PreparedJourney,
  args: { width: 390, dark: false, caller: 'reply', scenario: 'writing' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Current unsent writing through the installed new-thread, reply and inline-edit callers. Responses are prepared fixtures. Snapshot failure and replacement expose the optional editor port explicitly; no native execution or browser capture is claimed.',
      },
    },
  },
} satisfies Meta<typeof PreparedJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
const inspect: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const view = within(canvasElement);
  if (args.caller === 'new-thread')
    await userEvent.type(
      await view.findByRole('textbox', { name: m.thread_title_label() }),
      'Current unsent title · 日本語',
    );
  await userEvent.click(await view.findByRole('button', { name: m.thread_inspection_open() }));
  const dialog = await screen.findByRole('dialog');
  await expect(within(dialog).getByText(m.thread_inspection_reader())).toBeVisible();
  await expect(dialog.querySelectorAll('[data-slot="document-body"]').length).toBe(1);
};
const returnToRepair: NonNullable<Story['play']> = async (context) => {
  await inspect(context);
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(
    within(dialog).getAllByRole('button', {
      name: m.thread_inspection_repair_block({
        block: m.thread_inspection_named_block({
          kind: m.thread_inspection_heading(),
          text: 'A current unsent thought · 今の文章',
        }),
      }),
    })[0]!,
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const view = within(context.canvasElement);
  await expect(
    await view.findByRole('textbox', {
      name:
        context.args.caller === 'new-thread'
          ? m.thread_new_body_label()
          : context.args.caller === 'edit'
            ? m.thread_reply_body_label()
            : m.thread_reply_label(),
    }),
  ).toHaveFocus();
};
export const NewThreadPhoneLight: Story = { args: { caller: 'new-thread' }, play: returnToRepair };
export const NewThreadDesktopDark: Story = {
  args: { caller: 'new-thread', width: 1280, dark: true, scenario: 'long' },
  play: inspect,
};
export const ReplyPhoneDark: Story = { args: { dark: true }, play: returnToRepair };
export const ReplyDesktopLight: Story = { args: { width: 1280, scenario: 'long' }, play: inspect };
export const EditPhoneLight: Story = { args: { caller: 'edit' }, play: returnToRepair };
export const EditDesktopDark: Story = {
  args: { caller: 'edit', width: 1280, dark: true, scenario: 'long' },
  play: inspect,
};
export const EmptyBody: Story = { args: { scenario: 'empty' }, play: inspect };
export const PendingAttachment: Story = { args: { scenario: 'pending', dark: true }, play: inspect };
export const UnsupportedSnapshot: Story = {
  args: { scenario: 'unsupported' },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: m.thread_inspection_open() }));
    await expect(await screen.findByText(m.thread_inspection_recovery())).toBeVisible();
  },
};
export const ChangedDuringInspection: Story = {
  args: { scenario: 'changed', width: 1280 },
  play: async (context) => {
    await inspect(context);
    await userEvent.click(await screen.findByRole('button', { name: 'Prepared background editor transaction' }));
    await expect(await screen.findByText(m.thread_inspection_stale())).toBeVisible();
    await userEvent.click(await screen.findByRole('button', { name: m.thread_inspection_refresh() }));
    await expect(await screen.findByText('Prepared newer current writing')).toBeVisible();
  },
};
export const AccountReplacement: Story = {
  args: { scenario: 'account', dark: true },
  play: async (context) => {
    await inspect(context);
    await userEvent.click(await screen.findByRole('button', { name: m.thread_inspection_return() }));
    await userEvent.click(
      await within(context.canvasElement).findByRole('button', { name: 'Prepared account replacement and return' }),
    );
    await expect(await within(context.canvasElement).findByText(m.thread_authoring_session_changed())).toBeVisible();
  },
};
export const UncertainCommandLock: Story = {
  args: { scenario: 'unknown', width: 1280, dark: true },
  play: async (context) => {
    const view = within(context.canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
    await view.findByRole('button', { name: m.thread_write_retry() });
    await inspect(context);
    await expect(await screen.findByText(m.thread_inspection_unknown())).toBeVisible();
  },
};
