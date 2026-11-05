import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CopyForm } from '../library/copies-page';
import type { CopyItem } from '../library/copies-read';
import recording from '../kernel/recorded/library-copies.json';
import { setCopyKindsStory } from '../kernel/fake/copies-kinds';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

// Constructed editor fixtures use the real form and fake command transport, not native acceptance evidence.
const meta = {
  title: 'Patterns/Library/Copy editor journey',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone320: { name: 'Phone 320', styles: { width: '320px', height: '568px' }, type: 'mobile' },
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const original = recording.copies[0]!;
const profile = {
  kinds: [
    {
      id: 'print',
      label: 'Print',
      statuses: [
        { id: 'shelf', label: 'On shelf' },
        { id: 'loan', label: 'On loan' },
      ],
    },
    { id: 'digital', label: 'Digital', statuses: [{ id: 'available', label: 'Available' }] },
  ],
};
const fixture: CopyItem = {
  ...original,
  kind: 'print',
  status: 'shelf',
  kindLabel: 'Print at acceptance',
  statusLabel: 'Kept at acceptance',
  meaning: 'known',
  statusEditing: { state: 'unsupported' },
  subject: null,
  idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const action =
  'min-h-11 min-w-11 max-w-full rounded-lg border px-4 py-2 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring';
function Editor({ inline }: { inline: boolean }) {
  const [copy, setCopy] = useState<CopyItem | null>(() => {
    setCopyKindsStory();
    return fixture;
  });
  const [mode, setMode] = useState<'add' | 'edit' | null>(null);
  const [outcome, setOutcome] = useState('');
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  return (
    <div className="min-w-0 space-y-4 p-4">
      <div className="flex flex-wrap gap-3">
        <button className={action} onClick={() => setMode('add')}>
          {m.library_copy_add()}
        </button>
        {copy ? (
          <button className={action} onClick={() => setMode('edit')}>
            {m.library_copy_edit()}
          </button>
        ) : null}
      </div>
      <p role="status">{outcome}</p>
      {mode ? (
        <CopyForm
          key={mode}
          inline={inline}
          {...(mode === 'edit' && copy ? { copy } : { profile, sendKind: true })}
          subjectId={original.subjectId}
          addKey={key}
          onKey={setKey}
          onClose={() => setMode(null)}
          onCreated={(next) => {
            setCopy(next);
            setOutcome('Created');
          }}
          onSaved={(next) => {
            setCopy(next);
            setOutcome('Saved');
          }}
          onRemoved={() => {
            setCopy(null);
            setOutcome('Deleted');
          }}
        />
      ) : null}
    </div>
  );
}
const render = (inline: boolean) => (
  <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
    <Editor inline={inline} />
  </PatternStory>
);
function geometry(form: HTMLElement) {
  expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
  for (const element of form.querySelectorAll<HTMLElement>('button, input:not([type=hidden]), select')) {
    if (!element.getClientRects().length) continue;
    expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(element.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(element.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
  }
}
async function disclose(form: HTMLElement) {
  const canvas = within(form);
  const more = canvas.getByRole('button', { name: m.library_copy_more() });
  more.focus();
  await userEvent.keyboard('{Enter}');
  const panel = form.ownerDocument.getElementById(more.getAttribute('aria-controls')!)!;
  expect(panel).toBeVisible();
  expect(more).toHaveAttribute('aria-expanded', 'true');
  geometry(form);
  return canvas;
}
async function journey(canvasElement: HTMLElement) {
  const page = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole('button', { name: m.library_copy_add() }));
  const add = await body.findByRole('form', { name: m.library_copy_add() });
  const adding = await disclose(add);
  await userEvent.type(adding.getByLabelText(m.library_copy_location()), '  Study 📚  ');
  await userEvent.type(adding.getByLabelText(m.library_copy_note()), 'Exact note with spaces  ');
  // Native date controls accept and clear a full ISO value with the user's platform date editor.
  expect(adding.getByLabelText(m.library_copy_acquired())).toHaveAttribute('type', 'date');
  await userEvent.click(adding.getByRole('button', { name: m.library_copy_less() }));
  await userEvent.click(adding.getByRole('button', { name: m.library_copy_more() }));
  expect(adding.getByLabelText(m.library_copy_location())).toHaveValue('  Study 📚  ');
  adding.getByRole('button', { name: m.library_copy_add_submit() }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(page.getByRole('status')).toHaveTextContent('Created'));
  await userEvent.click(page.getByRole('button', { name: m.library_copy_edit() }));
  const edit = await body.findByRole('form', { name: m.library_copy_edit() });
  const editing = await disclose(edit);
  expect(editing.getByLabelText(m.library_copy_note())).toHaveValue('Exact note with spaces  ');
  await userEvent.type(editing.getByLabelText(m.library_copy_note()), 'updated');
  editing.getByRole('button', { name: m.library_copy_save() }).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(page.getByRole('status')).toHaveTextContent('Saved'));
  await userEvent.click(page.getByRole('button', { name: m.library_copy_edit() }));
  const deleting = await body.findByRole('form', { name: m.library_copy_edit() });
  const del = within(deleting).getByRole('button', { name: m.library_copy_delete() });
  del.focus();
  await userEvent.keyboard(' ');
  let confirmation = await body.findByRole('alertdialog', { name: m.library_copy_delete_question() });
  expect(within(confirmation).getByRole('button', { name: m.library_copy_cancel() })).toHaveFocus();
  geometry(deleting);
  await userEvent.keyboard('{Escape}');
  expect(body.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(del).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  confirmation = await body.findByRole('alertdialog', { name: m.library_copy_delete_question() });
  await userEvent.tab();
  expect(within(confirmation).getByRole('button', { name: m.library_copy_delete_confirm() })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(page.getByRole('status')).toHaveTextContent('Deleted'));
  expect(body.queryByRole('form')).not.toBeInTheDocument();
}
export const Inline: Story = { render: () => render(true), play: ({ canvasElement }) => journey(canvasElement) };
export const SheetOrDialog: Story = {
  render: () => render(false),
  play: ({ canvasElement }) => journey(canvasElement),
};
export const HistoricalClose: Story = {
  render: () => render(false),
  async play({ canvasElement }) {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.library_copy_edit() }));
    const form = await body.findByRole('form', { name: m.library_copy_edit() });
    expect(within(form).getByText('Print at acceptance')).toBeVisible();
    expect(within(form).getByText('Kept at acceptance')).toBeVisible();
    expect(within(form).queryByRole('combobox', { name: m.library_copy_new_status() })).not.toBeInTheDocument();
    await disclose(form);
    const dialog = form.closest('[role=dialog]')!;
    for (const control of dialog.querySelectorAll<HTMLElement>('[data-slot=dialog-close], [data-slot=drawer-close]')) {
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    }
    within(form).getByRole('button', { name: m.library_copy_cancel() }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(body.queryByRole('form')).not.toBeInTheDocument());
  },
};
