import type { Meta, StoryObj } from '@storybook/react-vite';
import { StrictMode, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import recording from '../kernel/recorded/library-collection.json';
import { m } from '../paraglide/messages.js';
import { CollectionPrivacyView, CollectionRow } from '../settings/collection-privacy';
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
type Scenario =
  | 'ready'
  | 'pending'
  | 'lost'
  | 'conflict'
  | 'empty'
  | 'paging'
  | 'owner-page-unavailable'
  | 'page-refused'
  | 'row-refused'
  | 'replay-refused';

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

function Example({ scenario = 'ready' }: { scenario?: Scenario }) {
  const [transport] = useState(() => {
    const first = scenario.endsWith('refused') || scenario === 'private' ? withVisibility(initial, 'private') : initial;
    let current = first;
    let receipt = current;
    let originalKey: string | undefined;
    let pageFailures = 0;
    let rowReads = 0;
    let pageReads = 0;
    const io: CollectionPrivacyIO = {
      save: async (input) => {
        if (scenario === 'row-refused') return { ok: false, reason: 'unavailable' };
        if (scenario === 'pending') return new Promise(() => {});
        if (scenario === 'conflict') {
          current = withVisibility(initial, 'unlisted', initial.revision + 1);
          return { ok: false, reason: 'conflict' };
        }
        if (originalKey === input.idempotencyKey) return { ok: true, collection: receipt };
        originalKey = input.idempotencyKey;
        current = withVisibility(current, input.visibility, input.revision + 1);
        receipt = current;
        if (scenario === 'lost' || scenario === 'replay-refused') {
          // Another native write happened after the committed command whose response was lost.
          current = withVisibility(initial, initial.visibility, receipt.revision + 1);
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, collection: current };
      },
      read: async () => {
        if (scenario === 'row-refused' || scenario === 'replay-refused') {
          rowReads++;
          if (rowReads === 1) return { ok: false, reason: 'forbidden' };
          if (rowReads === 2) return { ok: false, reason: 'unavailable' };
          return { ok: true, value: withVisibility(first, 'unlisted', first.revision + 3) };
        }
        return { ok: true, value: current };
      },
    };
    const read: CollectionPrivacyPageRead = async (cursor) => {
      pageReads++;
      if (scenario === 'owner-page-unavailable' && pageReads === 1) return { ok: false, reason: 'unavailable' };
      if (scenario === 'page-refused') {
        if (pageReads === 1) return { ok: true, value: { collections: [first], next: 'opaque-settings-page-2' } };
        if (pageReads === 2) return { ok: false, reason: 'forbidden' };
        if (cursor !== null) throw new Error('Denied paging must refresh the first native page');
        return {
          ok: true,
          value: {
            collections: [
              withVisibility({ ...initial, id: 'settings-current-collection', title: 'Current reading', revision: 3 }, 'private'),
            ],
            next: null,
          },
        };
      }
      if (scenario === 'empty') return { ok: true, value: { collections: [], next: null } };
      if (cursor === null)
        return {
          ok: true,
          value: { collections: [first], next: scenario === 'paging' ? 'opaque-settings-page-2' : null },
        };
      if (pageFailures++ === 0) throw new Error('Next page unavailable');
      return {
        ok: true,
        value: {
          collections: [withVisibility({ ...initial, id: 'settings-collection-3', title: 'Weekend reading', revision: 2 }, 'unlisted')],
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
export const PrivateCollection: Story = { render: () => <Example scenario="private" /> };
export const PublicChangedPrivate: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await view.findByText(m.settings_saved());
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_private() }));
  },
};
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
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example scenario="lost" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const select = await view.findByRole('combobox', { name: m.settings_privacy_visibility_label() });
    select.focus();
    await userEvent.keyboard('{HOME}{ARROWDOWN}{ENTER}');
    await view.findByText(m.settings_privacy_uncertain_title());
    const retry = view.getByRole('button', { name: m.settings_privacy_retry_original() });
    retry.focus();
    await userEvent.keyboard('{ENTER}');
    await view.findByText(m.settings_privacy_review_title());
    const save = view.getByRole('button', { name: m.settings_privacy_save_choice() });
    save.focus();
    await userEvent.keyboard('{ENTER}');
    await view.findByText(m.settings_saved());
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_private() }));
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
export const OwnerPageUnavailable: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example scenario="owner-page-unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_privacy_list_load_failed());
    await view.findByText(m.settings_privacy_list_retry());
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_retry() }));
    await view.findByRole('link', { name: initial.title });
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

export const CurrentPageReadRefused: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example scenario="page-refused" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('link', { name: initial.title });
    await userEvent.click(await view.findByRole('button', { name: m.settings_privacy_load_more() }));
    await view.findByText(m.settings_privacy_forbidden());
    await expect(view.queryByText(initial.title)).toBeNull();
    await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
    await expect(view.queryByRole('combobox')).toBeNull();
    await expect(view.queryByText(m.settings_privacy_current({ visibility: m.settings_privacy_private() }))).toBeNull();
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_retry() }));
    await view.findByRole('link', { name: 'Current reading' });
    await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
    await expect(view.getAllByRole('combobox')).toHaveLength(1);
  },
};

async function assertRowReadRefusal(canvasElement: HTMLElement, replay: boolean) {
  const view = within(canvasElement);
  const select = await view.findByRole('combobox', { name: m.settings_privacy_visibility_label() });
  await waitFor(() => expect(select).toBeEnabled());
  await userEvent.selectOptions(select, 'public');
  await view.findByText(m.settings_privacy_uncertain_title());
  await userEvent.selectOptions(select, 'unlisted');
  await userEvent.click(
    view.getByRole('button', {
      name: replay ? m.settings_privacy_retry_original() : m.settings_privacy_reload_row(),
    }),
  );
  await view.findByText(m.settings_privacy_forbidden());
  await expect(view.queryByText(initial.title)).toBeNull();
  await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
  await expect(view.queryByRole('combobox')).toBeNull();
  await expect(view.queryByText(m.settings_privacy_current({ visibility: m.settings_privacy_private() }))).toBeNull();
  await expect(view.queryByRole('button', { name: m.settings_privacy_retry_original() })).toBeNull();
  await expect(view.queryByRole('button', { name: m.settings_privacy_save_choice() })).toBeNull();
  await view.findByText(m.settings_privacy_uncertain_title());
  await expect(view.queryByText(m.settings_saved())).toBeNull();
  await userEvent.click(view.getByRole('button', { name: m.settings_privacy_reload_row() }));
  await view.findByText(m.settings_privacy_unavailable());
  await expect(view.queryByRole('combobox')).toBeNull();
  await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
  await userEvent.click(view.getByRole('button', { name: m.settings_privacy_reload_row() }));
  await waitFor(() => expect(view.getByRole('combobox')).toHaveValue('unlisted'));
  await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_unlisted() }));
  await expect(view.queryByText(m.settings_saved())).toBeNull();
}

export const CurrentRowReadRefused: Story = {
  render: () => <Example scenario="row-refused" />,
  play: ({ canvasElement }) => assertRowReadRefusal(canvasElement, false),
};
export const ReplayCurrentReadRefused: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <Example scenario="replay-refused" />,
  play: ({ canvasElement }) => assertRowReadRefusal(canvasElement, true),
};

/** Constructed failure inputs exercise the actual recovery controls; they are not native proof. */
function RetryDelayExample({ scenario }: { scenario: 'first-page' | 'independent' | 'readback' }) {
  const [transport] = useState(() => {
    const second = { ...initial, id: 'settings-delay-second', title: 'Weekend reading' };
    const rows = [initial, second];
    const attempts = new Map<string, VisibilityAttempt>();
    let pageReads = 0;
    let rowReads = 0;
    const io: CollectionPrivacyIO = {
      save: async (input) => {
        const original = attempts.get(input.collectionId);
        if (!original) {
          attempts.set(input.collectionId, input);
          return {
            ok: false,
            reason: 'unavailable',
            ...(scenario === 'independent'
              ? {
                  failure: {
                    status: 429,
                    code: 'rate_limited',
                    retryable: true,
                    retryAfter: input.collectionId === initial.id ? '2' : '60',
                    requestId: input.collectionId,
                  },
                }
              : {}),
          };
        }
        if (input !== original) throw new Error('Recovery must replay the exact original command');
        const row = rows.find((row) => row.id === input.collectionId)!;
        return { ok: true, collection: withVisibility(row, input.visibility, input.revision + 1) };
      },
      read: async (id) => {
        if (scenario === 'readback' && rowReads++ === 0)
          return {
            ok: false,
            reason: 'unavailable',
            failure: {
              status: 503,
              code: 'dependency_unavailable',
              retryable: true,
              retryAfter: '60',
              requestId: 'current-read',
            },
          };
        const row = rows.find((row) => row.id === id)!;
        return { ok: true, value: { ...row, revision: row.revision + 2 } };
      },
    };
    const read: CollectionPrivacyPageRead = async () => {
      pageReads++;
      if ((scenario === 'first-page' && pageReads === 1) || (scenario === 'independent' && pageReads === 2))
        return {
          ok: false,
          reason: 'unavailable',
          failure: {
            status: 503,
            code: 'dependency_unavailable',
            retryable: true,
            retryAfter: '60',
            requestId: 'owner-page',
          },
        };
      return {
        ok: true,
        value: {
          collections: scenario === 'independent' ? rows : [initial],
          next: scenario === 'independent' ? 'exact-page-2' : null,
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

export const InitialPageRetryDelay: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RetryDelayExample scenario="first-page" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_privacy_page_retry_wait());
    await expect(view.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
    await expect(view.queryByRole('combobox')).toBeNull();
  },
};

export const IndependentRecoveryDelays: Story = {
  render: () => <RetryDelayExample scenario="independent" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('link', { name: initial.title });
    const selects = view.getAllByRole('combobox');
    await waitFor(() => expect(selects[0]).toBeEnabled());
    await userEvent.selectOptions(selects[0]!, 'private');
    await expect(view.getByRole('button', { name: m.settings_privacy_retry_original() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_privacy_reload_row() })).toBeDisabled();
    await expect(selects[1]).toBeEnabled();
    await expect(view.getByRole('button', { name: m.settings_privacy_load_more() })).toBeEnabled();
    await userEvent.selectOptions(selects[1]!, 'private');
    await userEvent.selectOptions(selects[0]!, 'unlisted');
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_load_more() }));
    await view.findByText(m.settings_privacy_page_retry_wait());
    const retries = view.getAllByRole('button', { name: m.settings_privacy_retry_original() });
    const reloads = view.getAllByRole('button', { name: m.settings_privacy_reload_row() });
    await expect(retries[1]).toBeDisabled();
    await expect(reloads[1]).toBeDisabled();
    await expect(selects[0]).toBeEnabled();
    await expect(selects[0]).toHaveValue('unlisted');
    await waitFor(() => expect(retries[0]).toBeEnabled(), { timeout: 5000 });
    await expect(reloads[0]).toBeEnabled();
    await expect(retries[1]).toBeDisabled();
    await expect(reloads[1]).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
    // Expiry made no replay or page read; both original outcomes still need deliberate recovery.
    await expect(view.getAllByText(m.settings_privacy_uncertain_title())).toHaveLength(2);
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await userEvent.click(retries[0]!);
    await view.findByText(m.settings_privacy_review_title());
    await expect(selects[0]).toHaveValue('unlisted');
    await expect(
      view.getAllByText(m.settings_privacy_current({ visibility: m.settings_privacy_public() })),
    ).toHaveLength(2);
  },
};

export const ReplayReadbackRetryDelay: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RetryDelayExample scenario="readback" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    await userEvent.selectOptions(view.getByRole('combobox'), 'unlisted');
    await userEvent.click(await view.findByRole('button', { name: m.settings_privacy_retry_original() }));
    await view.findByText(m.settings_privacy_row_retry_wait());
    await expect(view.getByRole('button', { name: m.settings_privacy_retry_original() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_privacy_reload_row() })).toBeDisabled();
    await expect(view.getByRole('combobox')).toBeEnabled();
    await expect(view.getByRole('combobox')).toHaveValue('unlisted');
    await expect(view.queryByText(m.settings_saved())).toBeNull();
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_public() }));
  },
};

/** Constructed cursor/transport failures use the real list and row recovery controls, not native proof. */
function ListRestartExample({ scenario }: { scenario: 'cursor' | 'exhausted' | 'failed' | 'unresolved' }) {
  const [transport] = useState(() => {
    let pageReads = 0;
    let current = initial;
    let original: VisibilityAttempt | null = null;
    const io: CollectionPrivacyIO = {
      save: async (input) => {
        if (scenario === 'unresolved' && !original) {
          original = input;
          return { ok: false, reason: 'unavailable' };
        }
        if (original && input.idempotencyKey === original.idempotencyKey && input !== original)
          throw new Error('Recovery must retain the original command');
        current = withVisibility(current, input.visibility, input.revision + 1);
        return { ok: true, collection: current };
      },
      read: async () => ({ ok: true, value: current }),
    };
    const read: CollectionPrivacyPageRead = async (cursor) => {
      pageReads++;
      if (pageReads === 1)
        return {
          ok: true,
          value: {
            collections: scenario === 'exhausted' ? [initial, { ...initial, id: 'old-second-page-row' }] : [initial],
            next: scenario === 'cursor' ? 'opaque+/expired==' : null,
          },
        };
      if (scenario === 'cursor' && cursor !== null)
        return { ok: false, reason: 'unavailable', failure: { status: 400, code: 'invalid_cursor' } };
      if (scenario === 'failed' && pageReads === 2)
        return {
          ok: false,
          reason: 'unavailable',
          failure: { status: 503, code: 'dependency_unavailable', retryAfter: '60' },
        };
      if (cursor !== null) throw new Error('Explicit list refresh must request the first page');
      return {
        ok: true,
        value: {
          collections: [
            withVisibility({ ...current, title: 'Current reading' }, 'unlisted', current.revision + 2),
          ],
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

export const RejectedCursorRestart: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <ListRestartExample scenario="cursor" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_privacy_load_more() }));
    await view.findByText(m.settings_privacy_unavailable());
    await userEvent.click(view.getByRole('button', { name: m.settings_retry() }));
    await view.findByText(m.settings_privacy_unavailable());
    await view.findByRole('link', { name: initial.title });
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_refresh_list() }));
    await view.findByRole('link', { name: 'Current reading' });
    await expect(view.queryByRole('link', { name: initial.title })).toBeNull();
    await expect(view.getAllByRole('combobox')).toHaveLength(1);
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
  },
};

export const ExhaustedListRefresh: Story = {
  render: () => <ListRestartExample scenario="exhausted" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findAllByRole('combobox');
    const select = view.getAllByRole('combobox')[0]!;
    await expect(view.getAllByRole('combobox')).toHaveLength(2);
    await expect(view.queryByRole('button', { name: m.settings_privacy_load_more() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_refresh_list() }));
    await view.findByRole('link', { name: 'Current reading' });
    await expect(view.getAllByRole('combobox')).toHaveLength(1);
    await expect(view.getByRole('combobox')).toBe(select); // The same row keeps its mounted controller.
    await expect(select).toHaveValue('unlisted');
    await view.findByText(m.settings_privacy_current({ visibility: m.settings_privacy_unlisted() }));
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};

export const FailedListRefresh: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <ListRestartExample scenario="failed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('link', { name: initial.title });
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_refresh_list() }));
    await view.findByText(m.settings_privacy_unavailable());
    await view.findByRole('link', { name: initial.title });
    await view.findByText(m.settings_privacy_page_retry_wait());
    await expect(view.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.settings_privacy_refresh_list() })).toBeDisabled();
    await expect(view.queryByText(m.settings_privacy_empty())).toBeNull();
    await expect(view.queryByText(m.settings_saved())).toBeNull();
  },
};

export const RestartProtectedWhileRowUnresolved: Story = {
  render: () => <ListRestartExample scenario="unresolved" />,
  play: async ({ canvasElement }) => {
    const view = await choosePrivate(canvasElement);
    const select = view.getByRole('combobox');
    const refresh = view.getByRole('button', { name: m.settings_privacy_refresh_list() });
    await view.findByText(m.settings_privacy_uncertain_title());
    await expect(refresh).toBeDisabled();
    await view.findByText(m.settings_privacy_refresh_blocked());
    await userEvent.selectOptions(select, 'unlisted');
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_retry_original() }));
    await view.findByText(m.settings_privacy_review_title());
    await expect(select).toHaveValue('unlisted');
    await expect(refresh).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_save_choice() }));
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);
    await view.findByRole('link', { name: 'Current reading' });
    await expect(view.getByRole('combobox')).toBe(select);
    await expect(select).toHaveValue('unlisted');
    await expect(view.queryByText(m.settings_privacy_refresh_blocked())).toBeNull();
  },
};
/** No QueryClient: explicit illustrative IO exercises the installed standalone row and its exact retry. */
function StandaloneRowExample() {
  const [sends, setSends] = useState(0);
  const [reads, setReads] = useState(0);
  const [transport] = useState(() => {
    let original: VisibilityAttempt | null = null;
    let current = withVisibility(initial, 'private');
    const io: CollectionPrivacyIO = {
      save: async (input) => {
        setSends((count) => count + 1);
        if (!original) {
          original = input;
          throw new Error('Illustrative response loss');
        }
        if (input !== original) throw new Error('Retry replaced the original command');
        current = withVisibility(current, input.visibility, input.revision + 1);
        return { ok: true, collection: current };
      },
      read: async () => {
        setReads((count) => count + 1);
        return { ok: true, value: current };
      },
    };
    return io;
  });
  return (
    <QueryClientContext.Provider value={undefined}>
      <StrictMode>
        <output aria-label="Standalone row writes">{sends}</output>
        <output aria-label="Standalone row reads">{reads}</output>
        <ul>
          <CollectionRow collection={withVisibility(initial, 'private')} io={transport} />
        </ul>
      </StrictMode>
    </QueryClientContext.Provider>
  );
}

export const StandaloneInjectedOriginalRetry: Story = {
  render: () => <StandaloneRowExample />,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const select = await view.findByRole('combobox');
    await expect(select).toBeEnabled();
    await userEvent.selectOptions(select, 'public');
    await view.findByText(m.settings_privacy_uncertain_title());
    await userEvent.selectOptions(select, 'unlisted');
    await expect(view.getByLabelText('Standalone row writes')).toHaveTextContent('1');
    await userEvent.click(view.getByRole('button', { name: m.settings_privacy_retry_original() }));
    await view.findByText(m.settings_privacy_review_title());
    await expect(select).toHaveValue('unlisted');
    await expect(view.getByLabelText('Standalone row writes')).toHaveTextContent('2');
    await expect(view.getByLabelText('Standalone row reads')).toHaveTextContent('1');
  },
};
