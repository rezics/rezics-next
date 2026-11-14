import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { editionDocumentDigest } from '../content-editions/edition-model';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { StudioWorkspace } from '../studio';
import type { StudioInput, StudioPort, StudioResult, StudioSelection } from '../studio/contract';

type Scenario = 'structured' | 'preview' | 'failed' | 'uncertain' | 'acknowledged' | 'replacement';
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
const ok = <T,>(value: T): StudioResult<T> => ({ ok: true, value });
const unused = async (): Promise<never> => {
  throw new Error('Unexpected request in the initial draft illustration.');
};
const title = 'A coastline before saving';
const richHtml = [
  '<h2>Before the boats return</h2>',
  '<p>Keep the <strong>shape of the argument</strong> from the first draft.</p>',
  '<ul><li><p>Record what you can see.</p></li><li><p>Keep the source notes together.</p></li></ul>',
  '<blockquote><p>The harbour sounds different at dawn.</p></blockquote>',
  '<table><tbody><tr><th><p>Time</p></th><th><p>Observation</p></th></tr>',
  '<tr><td><p>06:10</p></td><td><p>Two returning boats</p></td></tr></tbody></table>',
].join('');

/** Supplied responses illustrate the real composer. They do not establish native command acceptance. */
function fixture(scenario: Scenario, generation: number) {
  let current = true;
  let count = 0;
  let selection: StudioSelection | null = null;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const port: StudioPort = {
    isCurrent: () => current,
    documents: unused,
    open: unused,
    createDraft: unused,
    async createNativeDraft(command) {
      count++;
      if (scenario === 'replacement') await held;
      if (count === 1 && (scenario === 'uncertain' || scenario === 'failed')) {
        return {
          ok: false,
          error: {
            kind: scenario === 'uncertain' ? 'uncertain' : 'denied',
            message:
              scenario === 'uncertain' ? 'The response was lost.' : 'This destination does not admit this draft.',
          },
        };
      }
      selection = {
        revision: {
          exact: { postId: id(1), revisionId: id(2), sha256: await editionDocumentDigest(command.body) },
          title: command.title,
          body: command.body,
          mediaIds: command.mediaIds,
          savedAt: '2026-11-14T07:00:00Z',
        },
        native: { threadId: id(3), boardId: command.boardId, licence: command.licence, subjectIds: command.subjectIds },
        visibility: 'draft',
        permissions: { edit: true, publish: true },
      };
      return ok(selection);
    },
    async saveDraft(command) {
      if (!selection) return { ok: false, error: { kind: 'unavailable', message: 'No acknowledged draft.' } };
      selection = {
        ...selection,
        revision: {
          ...selection.revision,
          exact: { postId: id(1), revisionId: id(4), sha256: await editionDocumentDigest(command.body) },
          title: command.title,
          body: command.body,
        },
      };
      return ok(selection);
    },
    versions: unused,
    revision: unused,
    publications: unused,
    reviewPublication: unused,
    publish: unused,
  };
  const input: StudioInput = {
    visitKey: `rich-initial-${scenario}-${generation}`,
    projectId: id(5 + generation),
    title: m.own_drafts_title({}, { locale: getLocale() }),
    profile: { kind: 'articles', seriesTitle: null },
    documents: { items: [], nextCursor: null },
    publications: { items: [], nextCursor: null },
    canCreateDraft: true,
    nativeDrafts: true,
    canPublish: false,
  };
  return {
    input,
    port,
    finish,
    connect: () => {
      current = true;
      return () => {
        current = false;
      };
    },
    retire: () => {
      current = false;
    },
  };
}

function RichDraftCreateIllustration({ scenario }: { scenario: Scenario }) {
  const [generation, setGeneration] = useState(0);
  const prepared = useMemo(() => fixture(scenario, generation), [scenario, generation]);
  const [retired, setRetired] = useState<ReturnType<typeof fixture> | null>(null);
  useEffect(() => prepared.connect(), [prepared]);
  return (
    <div className="mx-auto max-w-screen-2xl p-4">
      <p role="note" className="mb-4 text-sm text-muted-foreground">
        Illustrative supplied outcomes with the installed composer and reader. Native create/continue and visual
        acceptance remain verifier work.
      </p>
      {scenario === 'replacement' ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              prepared.retire();
              setRetired(prepared);
              setGeneration((value) => value + 1);
            }}
          >
            Replace account visit
          </Button>
          {retired ? (
            <Button variant="outline" onClick={() => retired.finish()}>
              Finish old response
            </Button>
          ) : null}
        </div>
      ) : null}
      <StudioWorkspace input={prepared.input} port={prepared.port} />
    </div>
  );
}

const meta = {
  title: 'Studio/Structured initial draft',
  component: RichDraftCreateIllustration,
  args: { scenario: 'structured' },
  argTypes: { scenario: { control: false } },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Real first-save composer with shared rich editing and reading. Review en, zh-Hant, zh-Hans, ja, ko, de, fr and es, light/dark, phone390 and desktop1280. Supplied responses are illustrations, not native evidence.',
      },
    },
  },
} satisfies Meta<typeof RichDraftCreateIllustration>;
export default meta;
type Story = StoryObj<typeof meta>;

async function compose(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const navigation = canvasElement.querySelector<HTMLDetailsElement>('.studio-mobile-navigation')!;
  if (!navigation.open) await userEvent.click(navigation.querySelector('summary')!);
  const form = await canvas.findByRole('form', { name: m.studio_account_create() });
  const fields = within(form);
  await userEvent.type(fields.getByRole('textbox', { name: m.studio_account_board() }), id(7));
  await userEvent.type(fields.getByRole('textbox', { name: m.studio_account_title() }), title);
  const editor = await fields.findByRole('textbox', { name: m.studio_account_body() });
  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/html', richHtml);
  clipboardData.setData('text/plain', 'Before the boats return');
  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  await waitFor(() => expect(fields.getByRole('button', { name: m.studio_account_create() })).toBeEnabled());
  return { canvas, form, fields, editor };
}

export const StructuredInitialDraft: Story = {
  play: async ({ canvasElement }) => {
    const { fields, editor } = await compose(canvasElement);
    await expect(editor.querySelector('h2')).toHaveTextContent('Before the boats return');
    await expect(editor.querySelector('table')).toHaveTextContent('Two returning boats');
    await expect(fields.getByRole('button', { name: m.studio_account_create() })).toBeEnabled();
  },
};

export const PrivatePreview: Story = {
  args: { scenario: 'preview' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { fields, editor } = await compose(canvasElement);
    await userEvent.click(fields.getByRole('button', { name: m.studio_workspace_preview() }));
    const preview = fields.getByRole('region', { name: m.studio_workspace_preview_region() });
    await expect(preview.querySelector('h2')).toHaveTextContent('Before the boats return');
    await expect(preview.querySelector('strong')).toHaveTextContent('shape of the argument');
    await expect(preview.querySelector('table')).toHaveTextContent('Two returning boats');
    await userEvent.click(fields.getByRole('button', { name: m.studio_workspace_write() }));
    await expect(fields.getByRole('textbox', { name: m.studio_account_body() })).toBe(editor);
    await userEvent.click(fields.getByRole('button', { name: m.studio_workspace_preview() }));
  },
};

export const FailedCreation: Story = {
  args: { scenario: 'failed' },
  play: async ({ canvasElement }) => {
    const { fields, editor } = await compose(canvasElement);
    await userEvent.click(fields.getByRole('button', { name: m.studio_account_create() }));
    await fields.findByText(m.studio_native_failed());
    await expect(editor.querySelector('table')).toHaveTextContent('Two returning boats');
    await expect(fields.getByRole('button', { name: m.studio_account_create() })).toBeEnabled();
  },
};

export const UncertainCreation: Story = {
  args: { scenario: 'uncertain' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { fields } = await compose(canvasElement);
    await userEvent.click(fields.getByRole('button', { name: m.studio_account_create() }));
    await fields.findByRole('button', { name: m.studio_native_retry() });
    const titleField = fields.getByRole('textbox', { name: m.studio_account_title() });
    await userEvent.clear(titleField);
    await userEvent.type(titleField, 'Later edits kept outside the submitted intent');
    await expect(fields.getByText(m.studio_native_later_edits())).toBeVisible();
    await expect(fields.getByRole('button', { name: m.studio_native_retry() })).toBeEnabled();
    await expect(fields.getByRole('button', { name: m.studio_account_create() })).toBeDisabled();
  },
};

export const AcknowledgedTransition: Story = {
  args: { scenario: 'acknowledged' },
  globals: { locale: 'de', viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { canvas, fields } = await compose(canvasElement);
    await userEvent.click(fields.getByRole('button', { name: m.studio_account_create() }));
    const editor = await canvas.findByRole('textbox', { name: m.studio_workspace_article_document() });
    await expect(editor.querySelector('h2')).toHaveTextContent('Before the boats return');
    await expect(editor.querySelector('table')).toHaveTextContent('Two returning boats');
    await expect(canvas.getByRole('heading', { name: title, exact: true })).toHaveFocus();
    await expect(fields.getByRole('textbox', { name: m.studio_account_title() })).toHaveValue('');
    await userEvent.click(editor);
    await userEvent.keyboard('{End} More private editing.');
    await waitFor(() => expect(editor).toHaveTextContent('More private editing.'));
    await expect(editor.querySelector('table')).toHaveTextContent('Two returning boats');
  },
};

export const VisitReplacement: Story = {
  args: { scenario: 'replacement' },
  play: async ({ canvasElement }) => {
    const { canvas, fields, editor } = await compose(canvasElement);
    await userEvent.click(fields.getByRole('button', { name: m.studio_account_create() }));
    await userEvent.click(canvas.getByRole('button', { name: 'Replace account visit' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Finish old response' }));
    await expect(editor).not.toBeInTheDocument();
    const navigation = canvasElement.querySelector<HTMLDetailsElement>('.studio-mobile-navigation')!;
    if (!navigation.open) await userEvent.click(navigation.querySelector('summary')!);
    const destination = canvas.getByRole('textbox', { name: m.studio_account_board() });
    await userEvent.click(destination);
    await expect(destination).toHaveValue('');
    await expect(destination).toHaveFocus();
    await expect(canvas.queryByRole('textbox', { name: m.studio_workspace_article_document() })).toBeNull();
  },
};
