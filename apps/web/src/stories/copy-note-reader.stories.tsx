import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import recording from '../kernel/recorded/library-copies.json';
import { CopiesPage } from '../library/copies-page';
import type { CopyItem } from '../library/copies-read';
import { subjectOf } from '../library/reads';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

// UNRUN: supplied-page presentation fixtures, not native or browser acceptance evidence.
const meta = {
  title: 'Library/Copy note reader',
  id: 'patterns-library-copy-note-reader',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const original = recording.copies[0]!;
const subject = subjectOf(original.subject)!;
const exactNote = `  First line\twith spaces  \r\n\r\n${'無間隔📚'.repeat(350)}\n<script>literal text</script>\n  Last line  \t`;
const location = `  Shelf\t${'位置'.repeat(800)}\n\n  lower shelf  `;
const source = `Seller: ${'source_without_breaks'.repeat(150)}\r\nReceipt  42\t `;
const copy = (n: number, changes: Partial<CopyItem> = {}): CopyItem => ({
  ...original,
  id: `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`,
  idempotencyKey: `019a1b2c-3d4e-7f00-8a00-${String(n + 100).padStart(12, '0')}`,
  subject,
  kind: 'print',
  kindLabel: 'Print at acceptance',
  kindLabelLanguage: 'en',
  statusLabel: 'Kept at acceptance',
  statusLabelLanguage: 'en',
  meaning: 'known',
  location: null,
  source: null,
  note: exactNote,
  ...changes,
});

function ReaderStory({ copies }: { copies: CopyItem[] }) {
  return (
    <PatternStory visitor="Signed In" path={pagePaths['library-copies']}>
      <div className="w-full max-w-4xl p-4">
        <CopiesPage page={{ signedIn: true, subjectId: null, copies, next: null, addKey: copy(200).idempotencyKey }} />
      </div>
    </PatternStory>
  );
}

async function rowsOf(canvasElement: HTMLElement) {
  await within(canvasElement).findByRole('heading', { level: 1, name: m.library_copy_heading() });
  return [...canvasElement.querySelectorAll<HTMLElement>('ul > [data-slot="list-row"]')];
}

function reader(row: HTMLElement, label: string) {
  const group = within(row).getByRole('group', { name: label });
  const control = within(group).getByRole('button');
  const text = row.ownerDocument.getElementById(control.getAttribute('aria-controls')!)!;
  return { group, control, text };
}

function contained(element: HTMLElement) {
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}

export const ExactNote: Story = {
  name: 'Owner reads the exact recorded note',
  render: () => <ReaderStory copies={[copy(1)]} />,
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    const field = reader(row, m.library_copy_note());
    const title = row.querySelector('h2')!;
    const link = row.querySelector('a')!;
    const href = link.getAttribute('href');
    expect(link).toHaveAttribute('aria-labelledby', title.id);
    expect(field.text.textContent).toBe(exactNote);
    expect(getComputedStyle(field.text).whiteSpace).toBe('break-spaces');
    expect(getComputedStyle(field.text).getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(field.control).toHaveAttribute('aria-expanded', 'false');
    expect(field.control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    contained(row);
    await userEvent.click(field.control);
    expect(field.control).toHaveAttribute('aria-expanded', 'true');
    expect(field.text.textContent).toBe(exactNote);
    expect(field.text).not.toHaveClass('line-clamp-2');
    expect(row.querySelector('script')).toBeNull();
    contained(field.text);
    await userEvent.click(field.text);
    expect(link).toHaveAttribute('href', href!);
    expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(field.control);
    expect(field.control).toHaveAttribute('aria-expanded', 'false');
    expect(field.text.textContent).toBe(exactNote);
  },
};

export const LongSourceAndLocation: Story = {
  name: 'Owner reads long source and location',
  render: () => <ReaderStory copies={[copy(1, { location, source })]} />,
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    for (const [label, value] of [
      [m.library_copy_location(), location],
      [m.library_copy_source(), source],
    ]) {
      const field = reader(row, label!);
      expect(field.text.textContent).toBe(value);
      expect(getComputedStyle(field.text).overflowWrap).toBe('anywhere');
      contained(field.group);
      contained(row);
      await userEvent.click(field.control);
      expect(field.control).toHaveAttribute('aria-expanded', 'true');
      expect(field.text.textContent).toBe(value);
      contained(field.text);
      contained(row);
    }
    expect(reader(row, m.library_copy_note()).control).toHaveAttribute('aria-expanded', 'false');
  },
};

export const SeparatePhysicalCopies: Story = {
  name: 'Same edition, independent physical copies',
  render: () => <ReaderStory copies={[copy(1), copy(2)]} />,
  async play({ canvasElement }) {
    const rows = await rowsOf(canvasElement);
    expect(rows).toHaveLength(2);
    const first = reader(rows[0]!, m.library_copy_note());
    const second = reader(rows[1]!, m.library_copy_note());
    expect(first.text.id).not.toBe(second.text.id);
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe(rows[1]!.querySelector('a')!.getAttribute('href'));
    await userEvent.click(first.control);
    expect(first.control).toHaveAttribute('aria-expanded', 'true');
    expect(second.control).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(second.control);
    await userEvent.click(first.control);
    expect(second.control).toHaveAttribute('aria-expanded', 'true');
    expect(first.text.textContent).toBe(exactNote);
    expect(second.text.textContent).toBe(exactNote);
  },
};

export const UnresolvedHistory: Story = {
  name: 'Unavailable subject and unresolved historical meaning',
  render: () => (
    <ReaderStory
      copies={[
        copy(1, {
          subject: null,
          kind: null,
          status: 'historic/raw-status',
          meaning: 'unknown',
          kindLabel: undefined,
          statusLabel: undefined,
          statusEditing: { state: 'unavailable' },
          acquiredOn: null,
          disposedOn: null,
        }),
      ]}
    />
  ),
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    const ui = within(row);
    expect(ui.getByRole('heading', { level: 2, name: m.library_subject_unavailable() })).toBeVisible();
    expect(ui.queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(ui.getByText(m.library_copy_history_details(), { exact: true }));
    expect(ui.getByText(m.library_copy_meaning_unknown())).toBeVisible();
    expect([...row.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['null', 'historic/raw-status']);
    await userEvent.click(reader(row, m.library_copy_note()).control);
    expect(row.querySelector('details')).toHaveAttribute('open');
    expect(reader(row, m.library_copy_note()).text.textContent).toBe(exactNote);
    expect(ui.queryByText(`${m.library_copy_acquired()}:`)).not.toBeInTheDocument();
    expect(ui.queryByText(`${m.library_copy_disposed()}:`)).not.toBeInTheDocument();
  },
};

export const RetiredCurrentKind: Story = {
  name: 'Accepted labels remain readable when the current kind is retired',
  render: () => <ReaderStory copies={[copy(1, { statusEditing: { state: 'unsupported' } })]} />,
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    expect(within(row).getByText('Print at acceptance')).toHaveAttribute('lang', 'en');
    expect(within(row).getByText('Kept at acceptance')).toHaveAttribute('lang', 'en');
    await userEvent.click(reader(row, m.library_copy_note()).control);
    expect(reader(row, m.library_copy_note()).text.textContent).toBe(exactNote);
    expect(row.querySelector('details')).toBeNull();
  },
};

export const HistoricalMeaningUnavailable: Story = {
  name: 'Historical labels unavailable, exact facts still readable',
  render: () => (
    <ReaderStory
      copies={[
        copy(1, {
          kind: 'retired/raw-kind',
          status: 'old/status',
          meaning: 'unavailable',
          kindLabel: undefined,
          statusLabel: undefined,
          statusEditing: { state: 'unavailable' },
        }),
      ]}
    />
  ),
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    await userEvent.click(within(row).getByText(m.library_copy_history_details(), { exact: true }));
    expect(within(row).getByText(m.library_history_unavailable())).toBeVisible();
    expect([...row.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'retired/raw-kind',
      'old/status',
    ]);
    await userEvent.click(reader(row, m.library_copy_note()).control);
    expect(reader(row, m.library_copy_note()).text.textContent).toBe(exactNote);
  },
};

export const EmptyAndWhitespace: Story = {
  name: 'Missing, empty and whitespace-only notes',
  render: () => <ReaderStory copies={[copy(1, { note: null }), copy(2, { note: '' }), copy(3, { note: ' \n\t  ' })]} />,
  async play({ canvasElement }) {
    const rows = await rowsOf(canvasElement);
    for (const row of rows.slice(0, 2))
      expect(within(row).queryByRole('group', { name: m.library_copy_note() })).not.toBeInTheDocument();
    const field = reader(rows[2]!, m.library_copy_note());
    await userEvent.click(field.control);
    expect(field.text.textContent).toBe(' \n\t  ');
  },
};

export const KeyboardReading: Story = {
  name: 'Keyboard reading stays separate from subject navigation and editing',
  render: () => <ReaderStory copies={[copy(1)]} />,
  async play({ canvasElement }) {
    const row = (await rowsOf(canvasElement))[0]!;
    const field = reader(row, m.library_copy_note());
    row.querySelector('a')!.focus();
    await userEvent.tab();
    expect(field.control).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(field.control).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard(' ');
    expect(field.control).toHaveAttribute('aria-expanded', 'false');
    expect(field.control).toHaveFocus();
    await userEvent.tab();
    expect(within(row).getByRole('button', { name: m.library_copy_more_actions() })).toHaveFocus();
    expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).not.toBeInTheDocument();
  },
};
