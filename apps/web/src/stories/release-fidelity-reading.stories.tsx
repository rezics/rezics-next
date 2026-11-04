import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import type { ReleaseFidelityTransport } from '../features/catalogue/release-fidelity/view';
import { ReleaseFidelityPage } from '../features/catalogue/release-fidelity/view';
import { releaseFidelityFixture, releaseSubject } from '../kernel/fake/release-fidelity';
import { candidateContext } from '../subject/candidates';
import { getLocale } from '../paraglide/runtime';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

type ReadingScenario = 'admitted' | 'detail-unavailable';

function ReleaseFidelityReadingStory({ scenario = 'admitted' }: { scenario?: ReadingScenario }) {
  const locale = getLocale();
  const fixture = useMemo(() => releaseFidelityFixture(scenario, locale, 22), [locale, scenario]);
  const transport = useMemo<ReleaseFidelityTransport>(
    () => ({
      read: fixture.read,
      facts: {
        read: async () => ({ ok: false, reason: 'unavailable' }),
        propose: async () => ({ ok: false, reason: 'uncertain' }),
      } as never,
      relation: () => ({
        read: async () => ({ ok: false, reason: 'unavailable' }),
        propose: async () => ({ ok: false, reason: 'unavailable' }),
        confirm: async () => ({ ok: false, reason: 'unavailable' }),
      }),
      review: () => ({}) as never,
    }),
    [fixture],
  );
  const path = `/subjects/${releaseSubject}/japanese-paperback/release`;
  const route = useMemo(
    () =>
      createRootRoute({
        component: () => (
          <AppShell>
            <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-8">
              <h1 className="text-3xl font-semibold">Japanese paperback</h1>
              <ReleaseFidelityPage
                id={releaseSubject}
                context={candidateContext}
                locale={locale}
                transport={transport}
                search={async () => []}
              />
            </main>
          </AppShell>
        ),
      }),
    [locale, transport],
  );
  const router = useMemo(
    () =>
      createRouter({
        routeTree: route,
        history: createMemoryHistory({ initialEntries: [path] }),
      }),
    [path, route],
  );
  return (
    <PatternStory path={path} visitor="Signed Out">
      <RouterProvider router={router} />
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Release fidelity reading',
  component: ReleaseFidelityReadingStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'A current release visit with a bounded later relation page, one explicitly selected detail and the existing relation correction. Fixture data does not establish native or rendered acceptance.',
      },
    },
  },
} satisfies Meta<typeof ReleaseFidelityReadingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const AdmittedLaterPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: m.release_fidelity_related() }),
      `forward:schema:isBasedOn`,
    );
    await canvas.findByRole('button', { name: m.release_fidelity_next() });
    await userEvent.click(await canvas.findByRole('button', { name: m.release_fidelity_next() }));
    const repeated = await canvas.findAllByRole('button', { name: m.release_fidelity_select_detail() });
    await expect(repeated).toHaveLength(2);
    await userEvent.click(repeated[0]!);
    await canvas.findByText('978-1-11-000020-0');
    await expect(canvas.getByText('2019-11', { exact: false })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: m.correction_title() }));
    await canvas.findByRole('region', { name: m.relation_title() });
    await userEvent.click(canvas.getByRole('button', { name: m.work_parts_draft_close() }));
    await canvas.findByText('978-1-11-000020-0');
  },
};

export const DetailUnavailable: Story = {
  args: { scenario: 'detail-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.release_fidelity_next() }));
    await userEvent.click((await canvas.findAllByRole('button', { name: m.release_fidelity_select_detail() }))[0]!);
    await canvas.findByText(m.release_fidelity_detail_unavailable());
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
  },
};
