import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../kernel/recorded/library-collection.json';
import { m } from '../paraglide/messages.js';
import { CollectionPrivacyView } from '../settings/collection-privacy';
import type { CollectionPrivacyIO, CollectionPrivacyPageRead } from '../settings/collection-privacy-recovery';
import type { OwnedCollection } from '../settings/preferences';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Account/Collection privacy',
  component: CollectionPrivacyView,
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
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
type Scenario = 'ready' | 'pending' | 'lost' | 'conflict' | 'empty' | 'paging';

const initial: OwnedCollection = {
  id: recording.collection.id,
  title: recording.collection.title,
  revision: recording.collection.revision,
  visibility: 'public',
};

function Example({ scenario = 'ready' }: { scenario?: Scenario }) {
  const [transport] = useState(() => {
    let current = initial;
    let receipt = current;
    let originalKey: string | undefined;
    let pageFailures = 0;
    const io: CollectionPrivacyIO = {
      save: async (input) => {
        if (scenario === 'pending') return new Promise(() => {});
        if (scenario === 'conflict') {
          current = { ...initial, visibility: 'unlisted', revision: initial.revision + 1 };
          return { ok: false, reason: 'conflict' };
        }
        if (originalKey === input.idempotencyKey) return { ok: true, collection: receipt };
        originalKey = input.idempotencyKey;
        current = { ...current, visibility: input.visibility, revision: input.revision + 1 };
        receipt = current;
        if (scenario === 'lost') {
          // Another native write happened after the committed command whose response was lost.
          current = { ...initial, revision: receipt.revision + 1 };
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, collection: current };
      },
      read: async () => ({ ok: true, value: current }),
    };
    const read: CollectionPrivacyPageRead = async (cursor) => {
      if (scenario === 'empty') return { ok: true, value: { collections: [], next: null } };
      if (cursor === null)
        return {
          ok: true,
          value: { collections: [initial], next: scenario === 'paging' ? 'opaque-settings-page-2' : null },
        };
      if (pageFailures++ === 0) throw new Error('Next page unavailable');
      return {
        ok: true,
        value: {
          collections: [{ id: 'settings-collection-3', title: 'Weekend reading', visibility: 'unlisted', revision: 2 }],
          next: null,
        },
      };
    };
    return { io, read };
  });
  return (
    <div className="mx-auto max-w-3xl">
      <CollectionPrivacyView {...transport} />
    </div>
  );
}
async function choosePrivate(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  const select = await view.findByRole('combobox', { name: m.settings_privacy_visibility_label() });
  await waitFor(() => expect(select).toBeEnabled());
  await userEvent.selectOptions(select, 'private');
  return view;
}
export const Collections: Story = { render: () => <Example /> };
export const PendingSave: Story = {
  render: () => <Example scenario="pending" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await view.findByText(m.settings_saving());
    await expect(view.getByRole('combobox')).toHaveValue('private');
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_public() }));
  },
};
export const AmbiguousResponse: Story = {
  render: () => <Example scenario="lost" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await view.findByText(m.settings_privacy_uncertain_title());
    await view.findByRole('button', { name: m.settings_privacy_retry_original() });
    await expect(view.getByRole('combobox')).toHaveValue('private');
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const RetryWithLaterDraft: Story = {
  render: () => <Example scenario="lost" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await view.findByText(m.settings_privacy_uncertain_title());
    await userEvent.selectOptions(view.getByRole('combobox'), 'unlisted');
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_retry_original() }));
    await view.findByText(m.settings_privacy_review_title());
    await expect(view.getByRole('combobox')).toHaveValue('unlisted');
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_public() }));
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};
export const ConflictReload: Story = {
  render: () => <Example scenario="conflict" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await view.findByText(m.settings_privacy_conflict_title());
    await expect(view.getByRole('combobox')).toHaveValue('private');
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_reload_row() }));
    await waitFor(() => expect(view.getByRole('combobox')).toHaveValue('unlisted'));
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_unlisted() }));
  },
};
export const EmptyOwnerPage: Story = {
  render: () => <Example scenario="empty" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_privacy_empty());
    await expect(view.queryByRole('combobox')).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_privacy_load_more() })).toBeNull();
  },
};
export const FailedNextPage: Story = {
  render: () => <Example scenario="paging" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_privacy_load_more() }));
    await view.findByText(m.settings_privacy_unavailable());
    await view.findByRole('link', { name: initial.title });
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
  },
};
export const NextPageRecovered: Story = {
  render: () => <Example scenario="paging" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_privacy_load_more() }));
    await userEvent.click(await view.findByRole('button', { name: m.settings_retry() }));
    await view.findByRole('link', { name: 'Weekend reading' });
    await expect(view.getAllByRole('link', { name: initial.title })).toHaveLength(1);
    await expect(view.getAllByRole('combobox')).toHaveLength(2);
    await expect(view.queryByRole('button', { name: m.settings_privacy_load_more() })).toBeNull();
  },
};
