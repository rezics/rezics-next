import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useState, type ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { fromPlainText } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { AuthoringDepartureProvider } from '../threads/authoring-departure';
import { InlinePostEditor, PostComposer } from '../threads/composer';
import type { WriteFailure } from '../threads/actions';
import type { ReplyCommand } from '../threads/reply-context-intent';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

// Supplied controller outcomes only; no endpoint or native admission is simulated.
type EditCommand = Parameters<ComponentProps<typeof InlinePostEditor>['onSubmit']>[0];
const write = fn<(command: ReplyCommand | EditCommand) => Promise<WriteFailure>>();
const onLeave = fn();
const onCancel = fn<(index: number) => void>();
let resolveWrite: ((result: WriteFailure) => void) | undefined;
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const longBody =
  'A long opening post with enough words to demonstrate how the editor grows as the author writes.\n\nIt continues in another paragraph to show the writing surface at a useful height.';
const title = 'An opening that is not saved yet';
type Scenario = 'unsaved' | 'pending' | 'discard' | 'expired';

function DepartureExample({
  scenario,
  direction,
  enlargedText,
}: {
  scenario: Scenario;
  direction: 'ltr' | 'rtl';
  enlargedText: boolean;
}) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    value.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id(1), csrfToken: 'story-session' });
    return value;
  });
  const [router] = useState(() => {
    function AuthoringPage() {
      const [closed, setClosed] = useState<number[]>([]);
      return (
        <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4">
          <h1 className="text-2xl font-semibold">{m.thread_new_heading()}</h1>
          <AuthoringDepartureProvider>
            {scenario === 'discard' ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                {[0, 1].map((index) => (
                  <section key={index} data-editor={index} aria-label={`Edit ${index + 1}`} className="min-w-0">
                    {closed.includes(index) ? (
                      <p>Editor closed</p>
                    ) : (
                      <InlinePostEditor
                        initialBody={fromPlainText(longBody, 'blocks')}
                        revisionId="revision-1"
                        idempotencyKey={id(10 + index)}
                        containerId={id(2)}
                        onSubmit={write}
                        onCancel={() => {
                          onCancel(index);
                          setClosed((current) => [...current, index]);
                        }}
                        onSuccess={() => undefined}
                      />
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <PostComposer
                titleRequired
                initialKey={id(10)}
                boardId={id(2)}
                initialBody={fromPlainText(longBody, 'blocks')}
                onSubmit={write}
                onSuccess={() => undefined}
              />
            )}
            <Button type="button" variant="outline" onClick={() => void router.navigate({ href: '/inbox' })}>
              Leave conversation
            </Button>
          </AuthoringDepartureProvider>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null })
            }
          >
            Expire session
          </Button>
        </main>
      );
    }
    function Destination() {
      useEffect(() => {
        onLeave();
      }, []);
      return <h1>Inbox destination</h1>;
    }
    const root = createRootRoute({ component: Outlet });
    return createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/compose', component: AuthoringPage }),
        createRoute({ getParentRoute: () => root, path: '/inbox', component: Destination }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/compose'] }),
    });
  });
  useEffect(() => () => client.clear(), [client]);
  useEffect(() => {
    const previous = document.documentElement.dir;
    document.documentElement.dir = direction;
    return () => {
      document.documentElement.dir = previous;
    };
  }, [direction]);
  useEffect(() => {
    const previous = document.documentElement.style.fontSize;
    if (enlargedText) document.documentElement.style.fontSize = '200%';
    return () => {
      document.documentElement.style.fontSize = previous;
    };
  }, [enlargedText]);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Patterns/Community/Authoring departure interface',
  component: DepartureExample,
  args: { scenario: 'unsaved', direction: 'ltr', enlargedText: false },
  argTypes: { direction: { control: 'inline-radio', options: ['ltr', 'rtl'] }, scenario: { control: false } },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored UNRUN: actual departure provider/boundaries and production composers with memory router and seeded session query. Use these same four stories at phone390 and desktop1280, both directions, all eight locale and light/dark globals, and enlarged text. Exact localized warnings stay visible. Geometry/focus observations require a real browser; these supplied outcomes establish no native privacy, lifetime or growth proof. Reload is inspected without reloading Storybook.',
      },
    },
  },
  beforeEach: () => {
    onLeave.mockClear();
    onCancel.mockClear();
    resolveWrite = undefined;
    write.mockReset().mockImplementation(
      () =>
        new Promise<WriteFailure>((resolve) => {
          resolveWrite = resolve;
        }),
    );
  },
} satisfies Meta<typeof DepartureExample>;
export default meta;
type Story = StoryObj<typeof meta>;

function targetSize(control: HTMLElement) {
  const box = control.getBoundingClientRect();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(getComputedStyle(control).whiteSpace).toBe('normal');
  expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
}

async function observeDialog(discard: boolean, explanation: string, cancelCount = 0) {
  const dialog = await screen.findByRole('alertdialog', {
    name: (discard ? m.thread_authoring_discard_title() : m.thread_authoring_leave_title()).trim(),
  });
  const view = within(dialog);
  const stay = view.getByRole('button', { name: m.thread_authoring_stay() });
  const leave = view.getByRole('button', { name: discard ? m.thread_authoring_discard() : m.thread_authoring_leave() });
  await waitFor(() => expect(stay).toHaveFocus());
  await expect(dialog).toHaveAccessibleDescription(explanation);
  await expect(view.getByText(explanation, { exact: true })).toBeVisible();
  await expect(dialog.querySelector('details')).toBeNull();
  await expect(view.getAllByRole('button')).toHaveLength(2);
  targetSize(stay);
  targetSize(leave);
  const box = dialog.getBoundingClientRect();
  await expect(box.left).toBeGreaterThanOrEqual(0);
  await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await userEvent.tab();
  await expect(leave).toHaveFocus();
  await expect(leave.matches(':focus-visible')).toBe(true);
  await expect(parseFloat(getComputedStyle(leave).outlineWidth)).toBeGreaterThanOrEqual(2);
  await userEvent.tab();
  await expect(stay).toHaveFocus();
  await expect(stay.matches(':focus-visible')).toBe(true);
  await expect(parseFloat(getComputedStyle(stay).outlineWidth)).toBeGreaterThanOrEqual(2);
  await expect(onLeave).toHaveBeenCalledTimes(0);
  await expect(onCancel).toHaveBeenCalledTimes(cancelCount);
  return { dialog, stay, leave };
}

async function opening(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const input = await canvas.findByRole('textbox', { name: m.thread_title_label() });
  await userEvent.type(input, title);
  const editor = await waitFor(() => {
    const node = canvas.getByRole('textbox', { name: m.thread_new_body_label() });
    expect(node).toHaveClass('ProseMirror');
    return node;
  });
  return { canvas, input, editor, origin: canvas.getByRole('button', { name: 'Leave conversation' }) };
}

export const UnsavedDeparture: Story = {
  play: async ({ canvasElement }) => {
    const { input, editor, origin } = await opening(canvasElement);
    origin.focus();
    await userEvent.keyboard('{Enter}');
    await observeDialog(false, m.thread_authoring_leave_unsaved());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(origin).toHaveFocus());
    await expect(input).toHaveValue(title);
    await expect(editor).toHaveTextContent(
      'It continues in another paragraph to show the writing surface at a useful height.',
    );
    await expect(write).toHaveBeenCalledTimes(0);
    await userEvent.keyboard('{Enter}');
    const { stay } = await observeDialog(false, m.thread_authoring_leave_unsaved());
    await userEvent.click(stay);
    await waitFor(() => expect(origin).toHaveFocus());
    await expect(input).toHaveValue(title);
    await userEvent.keyboard('{Enter}');
    await observeDialog(false, m.thread_authoring_leave_unsaved());
  },
};

export const PendingDeparture: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const { canvas, input, editor, origin } = await opening(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_write_send() }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const command = structuredClone(write.mock.calls[0]![0]);
    await userEvent.click(origin);
    const { stay } = await observeDialog(false, m.thread_authoring_leave_pending());
    await userEvent.click(stay);
    await waitFor(() => expect(origin).toHaveFocus());
    await expect(input).toHaveValue(title);
    await expect(editor).toHaveTextContent('A long opening post with enough words');
    resolveWrite!({ ok: false, reason: 'unavailable' });
    await canvas.findByText(m.thread_write_unavailable());
    await userEvent.click(origin);
    await observeDialog(false, m.thread_authoring_leave_pending());
    await expect(write.mock.calls.map(([value]) => value)).toEqual([command]);
    await expect(onLeave).toHaveBeenCalledTimes(0);
    await expect(onCancel).toHaveBeenCalledTimes(0);
    await expect(write).toHaveBeenCalledTimes(1);
  },
};

export const ExplicitDiscard: Story = {
  args: { scenario: 'discard' },
  play: async ({ canvasElement, args }) => {
    const panels = [...canvasElement.querySelectorAll<HTMLElement>('[data-editor]')];
    for (const panel of panels) {
      const editor = await within(panel).findByRole('textbox', { name: m.thread_reply_body_label() });
      await userEvent.click(editor);
      await userEvent.keyboard(' An edit that has not been saved.');
      await userEvent.tab();
    }
    const origin = within(panels[0]!).getByRole('button', { name: m.thread_edit_cancel() });
    await userEvent.click(origin);
    const { stay } = await observeDialog(true, m.thread_authoring_discard_unsaved());
    await userEvent.click(stay);
    await waitFor(() => expect(origin).toHaveFocus());
    for (const panel of panels) await expect(panel).toHaveTextContent('An edit that has not been saved.');
    await userEvent.click(origin);
    const { leave } = await observeDialog(true, m.thread_authoring_discard_unsaved());
    await userEvent.click(leave);
    await waitFor(() => expect(panels[0]).toHaveTextContent('Editor closed'));
    await expect(onCancel.mock.calls).toEqual([[0]]);
    await expect(panels[1]).toHaveTextContent('An edit that has not been saved.');
    await expect(onLeave).toHaveBeenCalledTimes(0);
    await expect(write).toHaveBeenCalledTimes(0);
    await userEvent.click(within(panels[1]!).getByRole('button', { name: m.thread_edit_cancel() }));
    const second = await observeDialog(true, m.thread_authoring_discard_unsaved(), 1);
    if (args.enlargedText && getLocale() === 'de' && window.innerWidth <= 390) {
      const label = second.leave.querySelector('span')!;
      await expect(label.getBoundingClientRect().height).toBeGreaterThan(
        parseFloat(getComputedStyle(label).lineHeight),
      );
    }
  },
};

export const ExplicitDiscardLongRtl: Story = {
  ...ExplicitDiscard,
  args: { scenario: 'discard', direction: 'rtl', enlargedText: true },
  globals: { locale: 'de', viewport: { value: 'phone390' } },
};

export const SessionExpired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const { canvas, origin } = await opening(canvasElement);
    await userEvent.click(origin);
    await observeDialog(false, m.thread_authoring_leave_unsaved());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(origin).toHaveFocus());
    await userEvent.click(canvas.getByRole('button', { name: 'Expire session' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent(m.thread_authoring_session_changed());
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expect(canvasElement.textContent).not.toContain('A long opening post with enough words');
    await expect(canvasElement.innerHTML).not.toContain(title);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const reload = within(alert).getByRole('button', { name: m.settings_reload() });
    targetSize(reload);
    reload.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(reload).toHaveFocus();
    await expect(reload.matches(':focus-visible')).toBe(true);
    await expect(parseFloat(getComputedStyle(reload).outlineWidth)).toBeGreaterThanOrEqual(2);
    await expect(alert.scrollWidth).toBeLessThanOrEqual(alert.clientWidth + 1);
    await expect(onLeave).toHaveBeenCalledTimes(0);
    await expect(onCancel).toHaveBeenCalledTimes(0);
    await expect(write).toHaveBeenCalledTimes(0);
  },
};
