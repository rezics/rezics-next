import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ReleaseFidelityPage, type ReleaseFidelityTransport } from '../features/catalogue/release-fidelity/view';
import { releaseVisitExample, visitContext, visitRelease } from '../features/catalogue/release-fidelity/examples';
import { candidateContext } from '../subject/candidates';
import { getLocale } from '../paraglide/runtime';
import { PatternStory } from './page';

function CurrentVisit({
  context = 'selected',
  state = 'current',
}: {
  context?: 'selected' | 'global';
  state?: 'current' | 'empty' | 'concealed' | 'withheld' | 'unavailable' | 'destination-unavailable';
}) {
  const locale = getLocale();
  const selected = context === 'selected' ? visitContext : candidateContext;
  const router = useMemo(() => {
    const example = releaseVisitExample(selected, 'wd:Q20631656', locale);
    if (state === 'withheld') example.withhold();
    if (state === 'unavailable') example.unavailable();
    if (state === 'empty') example.remove();
    if (state === 'concealed') example.conceal();
    if (state === 'destination-unavailable') example.failTarget();
    const transport: ReleaseFidelityTransport = {
      read: example.read,
      facts: {
        read: async () => ({ ok: false, reason: 'unavailable' }),
        propose: async () => ({ ok: false, reason: 'uncertain' }),
      },
      relation: () => ({
        read: async () => ({ ok: false, reason: 'unavailable' }),
        propose: async () => ({ ok: false, reason: 'unavailable' }),
        confirm: async () => ({ ok: false, reason: 'unavailable' }),
      }),
      review: () => ({}) as never,
    };
    return createRouter({
      routeTree: createRootRoute({
        component: () => (
          <main className="mx-auto max-w-5xl p-4">
            <ReleaseFidelityPage
              id={visitRelease}
              context={selected}
              locale={locale}
              transport={transport}
              search={async () => []}
            />
          </main>
        ),
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, [locale, selected, state]);
  return (
    <PatternStory path="/subjects/release/release" visitor="Signed Out">
      <RouterProvider router={router} />
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Catalogue/Release current visit',
  component: CurrentVisit,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CurrentVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedContext: Story = {};
export const GlobalDestinations: Story = { args: { context: 'global' } };
export const EmptyStream: Story = { args: { state: 'empty' } };
export const ConcealedTargets: Story = { args: { state: 'concealed' } };
export const DestinationUnavailable: Story = { args: { state: 'destination-unavailable' } };

export const WithheldStream: Story = { args: { state: 'withheld' } };
export const UnavailableStream: Story = { args: { state: 'unavailable' } };
