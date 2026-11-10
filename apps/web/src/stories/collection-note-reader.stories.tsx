import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recorded from '../kernel/recorded/library-collection-members.json';
import { CollectionMemberList } from '../library/collection-editor';
import { CollectionNoteReader } from '../library/collection-note-reader';
import { CollectionReadMembers } from '../library/collection-page';
import { subjectOf, type CollectionMember } from '../library/reads';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Collection Notes',
  id: 'patterns-collection-notes',
  component: CollectionNoteReader,
  args: { note: null, occurrence: 'Supplied occurrence' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'UNRUN supplied-data outcomes for the three actual read-only presentations. Notes retain exact text and independent occurrence state. Withdrawal examples supply absent or retired rows; they do not claim native authorization or current-admission verification. Review the same stories at phone390 and desktop1280 with locale globals.',
      },
    },
  },
} satisfies Meta<typeof CollectionNoteReader>;
export default meta;
type Story = StoryObj<typeof meta>;
type Presentation = 'occurrence' | 'list' | 'grid';
const subject = { ...subjectOf(recorded.members[0]!.subject)!, label: 'Repeated subject', cover: null };
const firstNote = `  First occurrence\n\n\t${'Exact spaces and lines.  '.repeat(18)}\n `;
const secondNote = `Second occurrence\n${'A different note. '.repeat(20)}`;
const unbroken = '界'.repeat(600);
const members: CollectionMember[] = [
  firstNote,
  secondNote,
  'Short note',
  null,
  '',
  'Concealed note',
  unbroken,
  ' \t\n ',
].map((note, index) => ({
  id: `occurrence-${index}`,
  subject: index === 5 ? null : subject,
  note,
  addedAt: recorded.members[0]!.addedAt,
}));

function ReadPresentation({
  presentation,
  items = members,
}: {
  presentation: Presentation;
  items?: CollectionMember[];
}) {
  return (
    <div className="min-w-0 p-4" data-note-presentation={presentation}>
      {presentation === 'occurrence' ? (
        <CollectionMemberList members={items} editing={false} firstPage />
      ) : (
        <CollectionReadMembers members={items} layout={presentation} onCopy={() => undefined} />
      )}
    </div>
  );
}

async function readNotes(canvasElement: HTMLElement) {
  const notes = [...canvasElement.querySelectorAll<HTMLParagraphElement>('[data-slot="collection-member-note"]')];
  await expect(notes.map((note) => note.textContent)).toEqual([
    firstNote,
    secondNote,
    'Short note',
    unbroken,
    ' \t\n ',
  ]);
  const controlFor = (note: HTMLParagraphElement) => note.parentElement!.querySelector<HTMLButtonElement>('button')!;
  await waitFor(() => expect(controlFor(notes[0]!)).not.toBeNull());
  const first = controlFor(notes[0]!);
  const second = controlFor(notes[1]!);
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(second.getAttribute('aria-label')).not.toBe(first.getAttribute('aria-label'));
  await expect(controlFor(notes[2]!)).toBeNull();
  await expect(canvasElement.textContent).not.toContain('Concealed note');
  await expect(canvasElement.querySelector('a button, a a, textarea, [data-drag-handle]')).toBeNull();
  for (const note of notes) {
    const lineHeight = Number.parseFloat(getComputedStyle(note).lineHeight);
    const lines = note.classList.contains('line-clamp-4') ? 4 : 2;
    await expect(note.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * lines + 1);
    await expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth + 1);
  }
  let navigations = 0;
  const preventNavigation = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) {
      navigations++;
      event.preventDefault();
    }
  };
  canvasElement.addEventListener('click', preventNavigation);
  try {
    first.focus();
    await userEvent.keyboard('{Enter}');
    await expect(first).toHaveFocus();
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await expect(first).toHaveAttribute('aria-controls', notes[0]!.id);
    await expect(notes[0]!.textContent).toBe(firstNote);
    await expect(notes[0]!.scrollHeight).toBeLessThanOrEqual(notes[0]!.clientHeight + 1);
    await expect(second).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    await expect(first).toHaveFocus();
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(first).toHaveFocus();
    await userEvent.click(controlFor(notes[3]!));
    await expect(notes[3]!.textContent).toBe(unbroken);
    await expect(notes[3]!.scrollWidth).toBeLessThanOrEqual(notes[3]!.clientWidth + 1);
    await expect(navigations).toBe(0);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  } finally {
    canvasElement.removeEventListener('click', preventNavigation);
  }
}

export const OccurrenceList: Story = {
  render: () => <ReadPresentation presentation="occurrence" />,
  play: async ({ canvasElement }) => readNotes(canvasElement),
};
export const MemberList: Story = {
  render: () => <ReadPresentation presentation="list" />,
  play: async ({ canvasElement }) => readNotes(canvasElement),
};
export const Grid: Story = {
  globals: {},
  render: () => <ReadPresentation presentation="grid" />,
  play: async ({ canvasElement }) => readNotes(canvasElement),
};

function WithdrawnNotes() {
  const [retired, setRetired] = useState(false);
  return (
    <>
      <button type="button" className="m-4 min-h-11" onClick={() => setRetired(true)}>
        Withdraw supplied rows
      </button>
      {(['occurrence', 'list', 'grid'] as const).map((presentation) => (
        <ReadPresentation key={presentation} presentation={presentation} items={retired ? [] : members.slice(0, 2)} />
      ))}
    </>
  );
}

export const DisclosedRowsWithdrawn: Story = {
  render: () => <WithdrawnNotes />,
  play: async ({ canvasElement }) => {
    const first = canvasElement.querySelector<HTMLButtonElement>('[data-collection-note-reader] button')!;
    await userEvent.click(first);
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Withdraw supplied rows' }));
    await expect(canvasElement.querySelector('[data-collection-note-reader]')).toBeNull();
    await expect(canvasElement.textContent).not.toContain(firstNote);
  },
};

export const NoDisclosedNotes: Story = {
  render: () => (
    <>
      {(['occurrence', 'list', 'grid'] as const).map((presentation) => (
        <ReadPresentation key={presentation} presentation={presentation} items={members.slice(3, 6)} />
      ))}
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-collection-note-reader]')).toBeNull();
    await expect(canvasElement.textContent).not.toContain('Concealed note');
    await expect(within(canvasElement).getAllByText(m.library_subject_unavailable())).toHaveLength(3);
  },
};
