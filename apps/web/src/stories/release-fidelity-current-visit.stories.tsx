import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ReleaseFidelityPage, type ReleaseFidelityTransport } from '../features/catalogue/release-fidelity/view';
import { releaseVisitExample, visitContext, visitRelease } from '../features/catalogue/release-fidelity/examples';
import { candidateContext } from '../subject/candidates';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import { subjectVisitReturn } from '../features/pages/subject-visit-navigation';
import { PatternStory } from './page';

function CurrentVisit({
  context = 'selected',
  state = 'current',
  origin = 'unavailable',
}: {
  context?: 'selected' | 'global';
  state?: 'current' | 'empty' | 'concealed' | 'withheld' | 'unavailable' | 'destination-unavailable';
  origin?: 'available' | 'unavailable';
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
    const returnTo =
      origin === 'available'
        ? subjectVisitReturn(
            `${subjectHref({ id: visitRelease, label: 'Current release' }, locale).href}?${new URLSearchParams({ context: selected })}`,
            locale,
          )
        : undefined;
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
              returnTo={returnTo}
            />
          </main>
        ),
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, [locale, origin, selected, state]);
  return (
    <PatternStory path="/subjects/release/release" visitor="Signed Out">
      <RouterProvider router={router} />
    </PatternStory>
  );
}

const meta = {
  title: 'Catalogue/Release current visit',
  id: 'pages-catalogue-release-current-visit',
  component: CurrentVisit,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CurrentVisit>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectedContext: Story = {};
export const SelectedContextWithPublicOrigin: Story = { args: { origin: 'available' } };
export const SelectedContextWithUnsupportedPublicReturns: Story = { args: { origin: 'unavailable' } };
export const GlobalDestinations: Story = { args: { context: 'global' } };
export const EmptyStream: Story = { args: { state: 'empty' } };
export const ConcealedTargets: Story = { args: { state: 'concealed' } };
export const DestinationUnavailable: Story = { args: { state: 'destination-unavailable' } };

export const WithheldStream: Story = { args: { state: 'withheld' } };
export const UnavailableStream: Story = { args: { state: 'unavailable' } };
