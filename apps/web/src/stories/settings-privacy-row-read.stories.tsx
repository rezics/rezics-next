import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../kernel/recorded/library-collection.json';
import { m } from '../paraglide/messages.js';
import { CollectionPrivacyView } from '../settings/collection-privacy';
import type {
  CollectionPrivacyIO,
  CollectionPrivacyPageRead,
  VisibilityAttempt,
} from '../settings/collection-privacy-recovery';
import type { OwnedCollection } from '../settings/preferences';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Account/Collection privacy',
  component: CollectionPrivacyView,
  parameters: {
    layout: 'padded',
  },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/settings#privacy">
        <Story />
      </PatternStory>
    ),
  ],
} satisfies Meta<typeof CollectionPrivacyView>;
export default meta;
type Story = StoryObj;

const initial: OwnedCollection = {
  id: recording.collection.id,
  title: recording.collection.title,
  kind: 'curated',
  membershipKind: 'curated',
  revision: recording.collection.revision,
  visibility: 'public',
  allowedVisibilityActions: ['private', 'unlisted'],
};
const withVisibility = (
  collection: OwnedCollection,
  visibility: OwnedCollection['visibility'],
  revision = collection.revision,
): OwnedCollection => ({
  ...collection,
  visibility,
  revision,
  allowedVisibilityActions: (['private', 'unlisted', 'public'] as const).filter((value) => value !== visibility),
});

type RequestJournal = {
  pageReads: number;
  currentReads: number;
  writes: number;
  writeCollectionId: string;
  writeRevision: string;
  writeVisibility: string;
  writeHasIdempotencyKey: string;
  conflictCurrentVisibility: string;
};

const emptyJournal: RequestJournal = {
  pageReads: 0,
  currentReads: 0,
  writes: 0,
  writeCollectionId: '',
  writeRevision: '',
  writeVisibility: '',
  writeHasIdempotencyKey: '',
  conflictCurrentVisibility: '',
};

function createJourney(report: (journal: RequestJournal) => void) {
  let journal = { ...emptyJournal };
  let current = initial;
  const publish = () => report({ ...journal });

  const io: CollectionPrivacyIO = {
    save: async (input: VisibilityAttempt) => {
      journal = {
        ...journal,
        writes: journal.writes + 1,
        writeCollectionId: input.collectionId,
        writeRevision: String(input.revision),
        writeVisibility: input.visibility,
        writeHasIdempotencyKey: input.idempotencyKey ? 'yes' : 'no',
      };
      current = withVisibility(current, 'unlisted', current.revision + 1);
      journal.conflictCurrentVisibility = current.visibility;
      publish();
      if (journal.writes !== 1) throw new Error('Unexpected additional Collection visibility write');
      return { ok: false, reason: 'conflict' };
    },
    read: async (id) => {
      journal = { ...journal, currentReads: journal.currentReads + 1 };
      publish();
      if (id !== initial.id) throw new Error('Collection privacy read used an unexpected id');
      if (journal.currentReads === 1) return { ok: false, reason: 'forbidden' };
      if (journal.currentReads === 2) return { ok: false, reason: 'unavailable' };
      if (journal.currentReads === 3) return { ok: true, value: current };
      throw new Error('Unexpected additional current visibility read');
    },
  };

  const read: CollectionPrivacyPageRead = async (cursor) => {
    journal = { ...journal, pageReads: journal.pageReads + 1 };
    publish();
    if (cursor !== null || journal.pageReads !== 1) throw new Error('Unexpected Collection page read');
    return { ok: true, value: { collections: [initial], next: null } };
  };

  return { io, read };
}

function ConflictReadRefusalJourney() {
  const [journal, setJournal] = useState(emptyJournal);
  const [transport] = useState(() => createJourney(setJournal));
  return (
    <div className="mx-auto max-w-3xl">
      <output
        hidden
        data-testid="collection-privacy-read-journey"
        data-page-reads={journal.pageReads}
        data-current-reads={journal.currentReads}
        data-writes={journal.writes}
        data-write-collection-id={journal.writeCollectionId}
        data-write-revision={journal.writeRevision}
        data-write-visibility={journal.writeVisibility}
        data-write-idempotency-key={journal.writeHasIdempotencyKey}
        data-conflict-current-visibility={journal.conflictCurrentVisibility}
      />
      <CollectionPrivacyView {...transport} />
    </div>
  );
}

export const ConflictReadRefusalRecovery: Story = {
  tags: ['!dev'],
  render: () => <ConflictReadRefusalJourney />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const journal = view.getByTestId('collection-privacy-read-journey');
    const currentPublic = m.settings_privacy_current({ visibility: m.settings_privacy_public() });
    const currentUnlisted = m.settings_privacy_current({ visibility: m.settings_privacy_unlisted() });
    const select = await view.findByRole('combobox', { name: m.settings_privacy_visibility_label() });

    await expect(select).toHaveValue('public');
    await view.findByText(currentPublic);
    await expect(journal).toHaveAttribute('data-page-reads', '1');
    await expect(journal).toHaveAttribute('data-current-reads', '0');
    await expect(journal).toHaveAttribute('data-writes', '0');

    await userEvent.selectOptions(select, 'private');
    await view.findByText(m.settings_privacy_conflict_title());
    await view.findByText(m.settings_privacy_conflict_text());
    await expect(view.getByRole('link', { name: initial.title })).toBeInTheDocument();
    await expect(view.getByRole('combobox')).toHaveValue('private');
    await view.findByText(currentPublic);
    await expect(journal).toHaveAttribute('data-page-reads', '1');
    await expect(journal).toHaveAttribute('data-current-reads', '0');
    await expect(journal).toHaveAttribute('data-writes', '1');
    await expect(journal).toHaveAttribute('data-write-collection-id', initial.id);
    await expect(journal).toHaveAttribute('data-write-revision', String(initial.revision));
    await expect(journal).toHaveAttribute('data-write-visibility', 'private');
    await expect(journal).toHaveAttribute('data-write-idempotency-key', 'yes');
    await expect(journal).toHaveAttribute('data-conflict-current-visibility', 'unlisted');

    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_reload_row() }));
    await view.findByText(m.settings_privacy_read_failed_title());
    await view.findByText(m.settings_privacy_forbidden());
    await view.findByText(m.settings_privacy_reload_after_refusal());
    await expect(journal).toHaveAttribute('data-current-reads', '1');
    await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
    await expect(view.queryByText(currentPublic)).toBeNull();
    await expect(view.queryByText(currentUnlisted)).toBeNull();
    await expect(view.queryByRole('combobox')).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_privacy_retry_original() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_privacy_save_choice() })).toBeNull();
    await expect(view.queryByText(m.settings_saved())).toBeNull();

    const reload = view.getByRole('button', { name: m.settings_privacy_reload_row() });
    await expect(reload).toHaveClass('min-h-11', 'min-w-11');
    await userEvent.click(reload);
    await waitFor(() => expect(journal).toHaveAttribute('data-current-reads', '2'));
    await view.findByText(m.settings_privacy_read_failed_title());
    await view.findByText(m.settings_privacy_unavailable());
    await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
    await expect(view.queryByText(currentPublic)).toBeNull();
    await expect(view.queryByText(currentUnlisted)).toBeNull();
    await expect(view.queryByRole('combobox')).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_privacy_retry_original() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_privacy_save_choice() })).toBeNull();
    await expect(view.queryByText(m.settings_saved())).toBeNull();

    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_reload_row() }));
    await waitFor(() => expect(journal).toHaveAttribute('data-current-reads', '3'));
    await waitFor(() => expect(view.getByRole('combobox')).toHaveValue('unlisted'));
    await view.findByText(currentUnlisted);
    await expect(view.getByRole('link', { name: initial.title })).toBeInTheDocument();
    await expect(view.queryByText(m.settings_privacy_read_failed_title())).toBeNull();
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await expect(journal).toHaveAttribute('data-page-reads', '1');
    await expect(journal).toHaveAttribute('data-current-reads', '3');
    await expect(journal).toHaveAttribute('data-writes', '1');
    await expect(journal).toHaveAttribute('data-write-visibility', 'private');
    await expect(journal).toHaveAttribute('data-conflict-current-visibility', 'unlisted');
  },
};
