import type { Meta, StoryObj } from '@storybook/react-vite';
import { bundledRelease } from '@rezics/definitions/bundled';
import { expect, within } from 'storybook/test';
import { getLocale } from '../paraglide/runtime.js';
import { DiscoveryResults } from '../search/discovery-results';
import { qualifiedSearchExample } from '../search/work-context/examples';
import { realmCatalogueSubjectHref } from '../search/realm-catalogue-handoff';

function Example() {
  const locale = getLocale();
  const state = qualifiedSearchExample();
  const withheld = state.page.hits[3];
  if (withheld && 'workContext' in withheld && withheld.workContext?.state === 'current') {
    withheld.workContext.creators = { state: 'withheld' };
    withheld.workContext.relations = { state: 'unavailable', reason: 'response_limit' };
  }
  const search = `/${locale}/search?q=Echo&language=en&layout=compact&cursor=native-current`;
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <DiscoveryResults
        state={state}
        locale={locale}
        yearProperties={['schema:datePublished']}
        factDefinitions={bundledRelease.properties}
        subjectHrefFor={(subject) => realmCatalogueSubjectHref(subject, locale, search)}
      />
    </div>
  );
}
const meta = {
  title: 'Patterns/Search/Work context',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Supplied native-contract preview; installed callable and browser acceptance remain controller-owned. */
export const Homonyms: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('heading', { level: 2 })).toHaveLength(6);
    await expect(canvasElement.querySelectorAll('[data-context-kind="work"]')).toHaveLength(5);
    await expect(canvasElement.querySelector('[data-context-state="withheld"]')).toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-context-reason="response_limit"]')).toBeInTheDocument();
    const link = canvasElement.querySelector('[data-slot="list-row-link"]');
    await expect(link).toHaveAttribute('href', expect.stringContaining('via='));
  },
};
