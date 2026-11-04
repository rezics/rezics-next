import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { ShelfPreferencesCard } from '../settings/shelf-preferences';
import type { ShelfPreferences } from '../settings/preferences';
import { SettingsSessionContext, SettingsSessionOwner } from '../settings/settings-session-owner';
import { sessionQuery } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000701';
const csrfToken = 'type-layout-story-credential';
const book = 'schema:Book',
  movie = 'schema:Movie',
  absent = 'schema:Unavailable';
const meta = { title: 'Patterns/Library/Type layout defaults', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// Illustrative owner data, using the existing versioned editor rather than a second preference form.
function Editor() {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    value.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken });
    return value;
  });
  const [owner] = useState(() => new SettingsSessionOwner(client, csrfToken, subject));
  const [saved, setSaved] = useState<{ shelf: ShelfPreferences; version: number }>({
    shelf: { layouts: { all: 'grid', [movie]: 'table', [absent]: 'list' }, gridSize: 'large' },
    version: 1,
  });
  const current = useRef(saved);
  current.current = saved;
  return (
    <QueryClientProvider client={client}>
      <SettingsSessionContext.Provider value={owner}>
        <div className="mx-auto max-w-xl">
          <ShelfPreferencesCard
            initial={saved.shelf}
            version={saved.version}
            csrfToken={csrfToken}
            onVersionChange={(version) => setSaved((old) => ({ ...old, version }))}
            readTypes={async () => ({
              sessionSubject: subject,
              authorizationAgrees: true,
              requested: { cursor: null, limit: 20, locale: getLocale() },
              page: {
                state: 'loaded',
                types: [
                  { type: book, label: 'Books' },
                  { type: movie, label: 'Films' },
                ],
                next: null,
              },
            })}
            io={{
              read: async () => ({
                signedIn: true,
                accountId: subject,
                securityHref: null,
                preferences: { spoilerLevel: 0, suitability: 'blur', ...current.current },
              }),
              save: async (input) => {
                const shelf = input.shelf === null ? {} : { ...current.current.shelf };
                if (input.shelf?.layouts) {
                  const layouts = { ...shelf.layouts };
                  for (const [scope, layout] of Object.entries(input.shelf.layouts)) {
                    if (layout === null) delete layouts[scope];
                    else layouts[scope] = layout;
                  }
                  shelf.layouts = layouts;
                }
                const next = { shelf, version: current.current.version + 1 };
                current.current = next;
                setSaved(next);
                return { ok: true, preferences: { spoilerLevel: 0, suitability: 'blur', ...next } };
              },
            }}
          />
        </div>
      </SettingsSessionContext.Provider>
    </QueryClientProvider>
  );
}

const inspect = async (canvasElement: HTMLElement, type: string) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.settings_shelf_types_load() }));
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.settings_shelf_type() }), type);
  return canvas;
};
export const Inherited: Story = {
  render: () => <Editor />,
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = await inspect(canvasElement, book);
    await expect(canvas.getByText(m.settings_shelf_type_inherits({ layout: m.library_layout_grid() }))).toBeVisible();
  },
};
export const Overridden: Story = {
  render: () => <Editor />,
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = await inspect(canvasElement, movie);
    await expect(canvas.getByText(m.settings_shelf_type_override({ layout: m.library_layout_table() }))).toBeVisible();
  },
};
export const UnavailableTypeRemoval: Story = {
  render: () => <Editor />,
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = await inspect(canvasElement, absent);
    await userEvent.click(canvas.getByRole('button', { name: m.settings_shelf_type_remove() }));
    await expect(canvas.getByText(m.settings_shelf_type_inherits({ layout: m.library_layout_grid() }))).toBeVisible();
  },
};
