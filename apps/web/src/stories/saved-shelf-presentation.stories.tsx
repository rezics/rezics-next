import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { PersonalLibraryPage } from '../library/entries-page';
import type { PersonalLibraryView } from '../library/entries-read';
import { resolveShelfPresentation } from '../library/shelf-preferences';
import type { ShelfPreferences } from '../settings/preferences';
import { ShelfPreferencesCard } from '../settings/shelf-preferences';
import { SettingsSessionContext, SettingsSessionOwner } from '../settings/settings-session-owner';
import type { ReadingIO } from '../settings/reading-preferences';
import { sessionQuery } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000701';
const token = 'saved-shelf-story-token';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000702';
const initialShelf: ShelfPreferences = {
  layouts: { all: 'table', 'https://schema.org/Book': 'table' },
  sorts: {
    all: { field: 'last_activity', direction: 'desc' },
    planned: { field: 'title', direction: 'desc' },
  },
  gridSize: 'large',
  tableColumns: ['cover', 'title', 'creator', 'status', 'progress', 'rating', 'started', 'last_activity'],
};

const meta = {
  title: 'Patterns/Library/Saved shelf presentation',
  parameters: { layout: 'fullscreen', admitted: ['personal_library', 'reading_progress'] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const libraryPage: PersonalLibraryView = {
  signedIn: true,
  sort: { orderBy: 'lastActivity', direction: 'desc' },
  sortExplicit: false,
  entries: [
    {
      subjectId,
      state: 'in_progress',
      stateLabel: 'In progress',
      revision: 3,
      incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000703',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastActivityAt: '2026-01-03T00:00:00.000Z',
      finishedAt: null,
      activeProgressSession: {
        mode: 'cursor_position',
        unit: 'page',
        amount: null,
        total: '99',
        completedUnitCount: 0,
        locator: null,
        position: '12',
      },
      subject: {
        id: subjectId,
        type: 'https://schema.org/Book',
        types: ['https://schema.org/Book'],
        label: { value: 'A long way home', language: 'en' },
        cover: null,
      },
      changeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000704',
      removeKey: '0192f3a0-6c1e-7b2a-9d4e-000000000705',
    },
  ],
  next: null,
};

function mergeShelf(current: ShelfPreferences, patch: ShelfPreferences | null): ShelfPreferences {
  if (patch === null) return {};
  const next: ShelfPreferences = { ...current };
  if (patch.layouts) next.layouts = { ...current.layouts, ...patch.layouts };
  if (patch.sorts) next.sorts = { ...current.sorts, ...patch.sorts };
  if (patch.gridSize !== undefined) next.gridSize = patch.gridSize;
  if (patch.tableColumns !== undefined) next.tableColumns = [...patch.tableColumns];
  return next;
}

function SavedShelfJourney() {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken: token });
    return client;
  });
  const [owner] = useState(() => new SettingsSessionOwner(queryClient, token, accountId));
  const [saved, setSaved] = useState({ shelf: initialShelf, version: 4 });
  const current = useRef(saved);
  current.current = saved;
  const io = useRef<ReadingIO | null>(null);
  if (!io.current) {
    io.current = {
      read: async () => ({
        signedIn: true,
        accountId,
        preferences: { spoilerLevel: 0, suitability: 'blur', version: current.current.version, shelf: current.current.shelf },
        notifications: { reply: true, mention: true },
        securityHref: null,
      }),
      save: async (input) => {
        const next = {
          shelf: mergeShelf(current.current.shelf, input.shelf ?? null),
          version: current.current.version + 1,
        };
        current.current = next;
        setSaved(next);
        return {
          ok: true,
          preferences: { spoilerLevel: 0, suitability: 'blur', ...next },
        };
      },
    };
  }
  const resolved = resolveShelfPresentation({ type: 'https://schema.org/Book' }, saved.shelf);
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsSessionContext.Provider value={owner}>
        <main className="mx-auto grid max-w-7xl gap-6 p-4 sm:p-8 lg:grid-cols-2">
          <section aria-labelledby="saved-shelf-story-settings" className="min-w-0">
            <h1 id="saved-shelf-story-settings" className="mb-4 text-xl font-semibold">{m.settings_heading()}</h1>
            <ShelfPreferencesCard
              initial={saved.shelf}
              version={saved.version}
              csrfToken={token}
              io={io.current}
              onVersionChange={(version) => setSaved((old) => ({ ...old, version }))}
            />
          </section>
          <section aria-labelledby="saved-shelf-story-library" className="min-w-0">
            <h2 id="saved-shelf-story-library" className="mb-4 text-xl font-semibold">{m.library_heading()}</h2>
            <div data-testid="library-preview" data-layout={resolved.display.layout}>
              <PersonalLibraryPage
                page={libraryPage}
                continueState={{ state: 'loaded', entries: [], next: null }}
                locale={getLocale()}
                display={resolved.display}
              />
            </div>
          </section>
        </main>
      </SettingsSessionContext.Provider>
    </QueryClientProvider>
  );
}

async function saveLayout(canvasElement: HTMLElement, layout: 'grid' | 'table') {
  const canvas = within(canvasElement);
  const control = await canvas.findByRole('combobox', { name: m.settings_shelf_layout() });
  await userEvent.selectOptions(control, layout);
  await userEvent.click(canvas.getByRole('button', { name: m.settings_shelf_save() }));
  await canvas.findByRole('status');
  await expect(canvas.getByTestId('library-preview')).toHaveAttribute('data-layout', layout);
}

export const Phone390: Story = {
  render: () => <SavedShelfJourney />,
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => saveLayout(canvasElement, 'grid'),
};

export const Desktop1280: Story = {
  render: () => <SavedShelfJourney />,
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => saveLayout(canvasElement, 'grid'),
};
