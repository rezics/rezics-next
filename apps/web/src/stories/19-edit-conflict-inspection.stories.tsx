import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { EditConflictRecovery } from '../threads/edit-conflict-recovery';
import { InlinePostEditor } from '../threads/composer';
import type { CurrentPost, EditFailure } from '../threads/actions';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';

type Scenario = 'available' | 'missing' | 'erased' | 'unknown';
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function ConflictExample({ scenario = 'available', blocks = 10 }: { scenario?: Scenario; blocks?: number }) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    value.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: id(1),
      csrfToken: 'prepared-story-session',
    });
    return value;
  });
  const [draft] = useState((): DocumentSnapshot => {
    const text = fromPlainText(
      Array.from(
        { length: blocks },
        (_, index) =>
          `${index + 1}. My retained correction · 保留した文章 · 보관된 글 · Mein aufbewahrter Text\nhttps://example.test/${'a-long-unbroken-url-'.repeat(10)}`,
      ).join('\n'),
      'blocks',
    );
    return {
      ...text,
      doc: {
        type: 'doc',
        content: [
          ...text.doc.content!,
          {
            type: 'image',
            attrs: {
              id: 'prepared-retained-image',
              src: id(20),
              alt: 'Prepared selected image — unavailable in inspection',
            },
          },
        ],
      },
    };
  });
  const [current] = useState(
    () =>
      ({
        id: id(3),
        threadId: id(2),
        revisionId: id(4),
        securityRevision: 'prepared-security',
        route: 13,
        authorId: id(1),
        parentId: null,
        subjectIds: [],
        boardId: id(7),
        visibility: 'published',
        sha256: 'prepared-digest',
        voteCitation: null,
        availability: scenario === 'erased' ? 'erased' : 'available',
        body:
          scenario === 'missing' || scenario === 'erased'
            ? null
            : fromPlainText(
                Array.from(
                  { length: blocks },
                  (_, index) => `${index + 1}. Returned current text · 目前的文章 · Texto actual · Texte actuel`,
                ).join('\n'),
                'blocks',
              ),
        mediaIds: [],
        licence: 'CC-BY-4.0',
        createdAt: '2026-11-01T01:02:03Z',
        revisedAt: '2026-11-02T02:03:04Z',
      }) as unknown as CurrentPost,
  );
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto min-w-0 max-w-4xl space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          Prepared edit-conflict fixture; supplied outcomes, no native execution.
        </p>
        <InlinePostEditor
          initialBody={draft}
          initialMediaIds={[id(20)]}
          revisionId={id(5)}
          idempotencyKey={id(6)}
          containerId={id(2)}
          onSubmit={async (): Promise<EditFailure> =>
            scenario === 'unknown'
              ? { ok: false, reason: 'unavailable' }
              : { ok: false, reason: 'stale', currentPost: current }
          }
          onCancel={() => undefined}
          onSuccess={() => undefined}
        />
      </main>
    </QueryClientProvider>
  );
}

function ChangedInspectionExample({
  retired = false,
  currentChanged = false,
}: {
  retired?: boolean;
  currentChanged?: boolean;
}) {
  const origin = useRef<HTMLTextAreaElement>(null);
  const [controller] = useState(() => new AbortController());
  const [authority] = useState(() => ({}));
  const [draft] = useState(() => fromPlainText('Prepared retained writing before an external change.', 'blocks'));
  const [revision, setRevision] = useState(0);
  const latestRevision = useRef(0);
  const [result, setResult] = useState(
    () =>
      ({
        id: id(3),
        threadId: id(2),
        revisionId: id(4),
        securityRevision: 'prepared-security',
        body: fromPlainText('Prepared current document before its reader changes.', 'blocks'),
        availability: 'available',
        licence: 'CC-BY-4.0',
        mediaIds: [],
      }) as unknown as CurrentPost,
  );
  const [expired, setExpired] = useState(false);
  return (
    <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4">
      <p>Prepared external-change fixture; the controller changes this reading without a native request.</p>
      <textarea
        ref={origin}
        aria-label={m.thread_reply_body_label()}
        defaultValue="Prepared retained writing"
        className="min-h-32 w-full rounded-xl border p-3"
      />
      <EditConflictRecovery
        current={result}
        presentation={{
          body: draft,
          revision,
          authority,
          signal: controller.signal,
          inspectable: !expired,
          read: () => (expired ? null : { body: draft, revision: latestRevision.current }),
        }}
        onReplace={() => {
          throw new Error('An invalidated fixture cannot replace writing');
        }}
        returningFocus={() => origin.current}
      />
      <button
        type="button"
        data-prepared-change=""
        className="min-h-11 rounded-xl border p-3"
        onClick={() => {
          if (retired) {
            setExpired(true);
            controller.abort();
          } else if (currentChanged) {
            setResult({ ...result, revisionId: id(30) } as CurrentPost);
          } else {
            latestRevision.current++;
            setRevision(latestRevision.current);
          }
        }}
      >
        Apply prepared external change
      </button>
      {expired ? <p role="alert">{m.thread_authoring_session_changed()}</p> : null}
    </main>
  );
}

const meta = {
  title: 'Pages/Community/Edit Conflict Inspection',
  component: ConflictExample,
  parameters: { layout: 'fullscreen' },
  args: { scenario: 'available', blocks: 10 },
} satisfies Meta<typeof ConflictExample>;
export default meta;
type Story = StoryObj<typeof meta>;

const open: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const view = within(canvasElement);
  await view.findByRole('textbox', { name: m.thread_reply_body_label() });
  await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
  await userEvent.click(await view.findByRole('button', { name: m.thread_edit_review_current() }));
  const dialog = await screen.findByRole('alertdialog', { name: m.thread_inspect_title() });
  const scope = within(dialog);
  await scope.findByRole('heading', { name: m.thread_inspect_draft_title() });
  await scope.findByRole('heading', { name: m.thread_edit_current_title() });
  await waitFor(() => expect(scope.getByRole('button', { name: m.thread_edit_keep_editing() })).toHaveFocus());
  await expect(dialog.querySelectorAll('[data-conflict-section]').length).toBeLessThanOrEqual(20);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
const inspect: NonNullable<Story['play']> = async (context) => {
  await open(context);
  const dialog = screen.getByRole('alertdialog');
  const sides = dialog.querySelectorAll<HTMLElement>('[data-conflict-reading]');
  const retained = within(sides[0]!);
  await userEvent.click(retained.getByRole('button', { name: m.thread_inspect_next_sections() }));
  await userEvent.click(sides[0]!.querySelector<HTMLButtonElement>('[data-conflict-section]')!);
  await retained.findByRole('heading', { name: m.thread_inspect_selected_section({ number: 11 }) });
  await userEvent.click(retained.getByRole('button', { name: m.thread_inspect_full_document() }));
  await retained.findByRole('heading', { name: m.thread_inspect_complete_reading() });
};
const unavailable: NonNullable<Story['play']> = async (context) => {
  await open(context);
  await expect(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: m.thread_edit_replace_current() }),
  ).toBeDisabled();
};

export const PhoneLight: Story = {
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390' } },
  play: inspect,
};
export const DesktopDark: Story = {
  globals: { locale: 'de', theme: 'dark', viewport: { value: 'desktop1280' } },
  play: inspect,
};
export const TraditionalChinesePhoneDark: Story = {
  globals: { locale: 'zh-Hant', theme: 'dark', viewport: { value: 'phone390' } },
  play: inspect,
};
export const SimplifiedChineseDesktopLight: Story = {
  globals: { locale: 'zh-Hans', theme: 'light', viewport: { value: 'desktop1280' } },
  play: inspect,
};
export const JapanesePhoneLight: Story = {
  globals: { locale: 'ja', theme: 'light', viewport: { value: 'phone390' } },
  play: inspect,
};
export const KoreanDesktopDark: Story = {
  globals: { locale: 'ko', theme: 'dark', viewport: { value: 'desktop1280' } },
  play: inspect,
};
export const FrenchPhoneDark: Story = {
  globals: { locale: 'fr', theme: 'dark', viewport: { value: 'phone390' } },
  play: inspect,
};
export const SpanishDesktopLight: Story = {
  globals: { locale: 'es', theme: 'light', viewport: { value: 'desktop1280' } },
  play: inspect,
};
export const HundredSections: Story = {
  args: { blocks: 100 },
  globals: { viewport: { value: 'desktop1280' } },
  play: inspect,
};
export const CurrentBodyMissing: Story = {
  args: { scenario: 'missing' },
  globals: { viewport: { value: 'phone390' } },
  play: unavailable,
};
export const CurrentErased: Story = {
  args: { scenario: 'erased' },
  globals: { theme: 'dark', viewport: { value: 'desktop1280' } },
  play: unavailable,
};
export const KeepWriting: Story = {
  play: async (context) => {
    await open(context);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await expect(
      within(context.canvasElement).getByRole('textbox', { name: m.thread_reply_body_label() }),
    ).toHaveFocus();
  },
};
export const ReplaceDraft: Story = {
  play: async (context) => {
    await open(context);
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: m.thread_edit_replace_current() }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const editor = within(context.canvasElement).getByRole('textbox', { name: m.thread_reply_body_label() });
    await expect(editor).toHaveTextContent('Returned current text');
    await expect(editor).not.toHaveTextContent('My retained correction');
  },
};
export const UnknownDelivery: Story = {
  args: { scenario: 'unknown' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.thread_edit_save() }));
    await view.findByText(m.thread_edit_unavailable());
    await expect(view.queryByRole('button', { name: m.thread_edit_review_current() })).toBeNull();
  },
};

const changeDuringReview =
  (message: () => string): NonNullable<Story['play']> =>
  async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: m.thread_edit_review_current() }));
    await screen.findByRole('alertdialog');
    // Invoke the prepared external controller; modal keyboard/pointer interaction remains inside the visit.
    canvasElement.querySelector<HTMLButtonElement>('[data-prepared-change]')!.click();
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByText(message());
    await expect(within(dialog).getByRole('button', { name: m.thread_edit_replace_current() })).toBeDisabled();
    await expect(dialog.querySelector('[data-slot="document-body"]')).toBeNull();
  };
export const DraftChangedDuringInspection: Story = {
  render: () => <ChangedInspectionExample />,
  globals: { viewport: { value: 'phone390' } },
  play: changeDuringReview(() => m.thread_inspect_draft_changed()),
};
export const CurrentReadingChanged: Story = {
  render: () => <ChangedInspectionExample currentChanged />,
  globals: { theme: 'dark', viewport: { value: 'desktop1280' } },
  play: changeDuringReview(() => m.thread_inspect_current_changed()),
};
export const RetiredReading: Story = {
  render: () => <ChangedInspectionExample retired />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: m.thread_edit_review_current() }));
    await screen.findByRole('alertdialog');
    canvasElement.querySelector<HTMLButtonElement>('[data-prepared-change]')!.click();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await within(canvasElement).findByText(m.thread_authoring_session_changed());
    await expect(document.querySelector('[data-conflict-reading]')).toBeNull();
  },
};
