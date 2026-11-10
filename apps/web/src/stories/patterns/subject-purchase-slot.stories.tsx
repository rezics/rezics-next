import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { FeatureSlotsProvider } from '../../shell/feature-slots';
import { SubjectPage, type SubjectPageData } from '../../features/pages/subject';
import { useSubjectPurchaseContext, type SubjectPurchaseContext } from '../../features/pages/subject-slots';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import recordedPage from '../../kernel/recorded/subject-page.json';
import { PatternStory } from '../page';

const meta = {
  title: 'Subjects/Purchase entry slot',
  id: 'patterns-subjects-purchase-entry-slot',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A region fixture, making no offer, ownership or entitlement claim. */
function OwnerRegion({ subjectId }: SubjectPurchaseContext) {
  const context = useSubjectPurchaseContext();
  return (
    <p data-owner-purchase-region className="rounded-xl border p-4 text-sm">
      Owner-supplied purchase/benefit region <code>{subjectId}</code> ({context?.locale})
    </p>
  );
}
function PurchasePattern({ populated = false, privateOnly = false }: { populated?: boolean; privateOnly?: boolean }) {
  return (
    <PatternStory>
      <FeatureSlotsProvider
        {...(populated
          ? { subjectPurchase: privateOnly ? { privateRegion: OwnerRegion } : { publicRegion: OwnerRegion } }
          : {})}
      >
        <div className="max-w-5xl p-4">
          <SubjectPage
            page={recordedPage as unknown as SubjectPageData}
            locale={getLocale()}
            renderJsonLd={false}
            messages={{
              unknown: m.subject_value_unknown(),
              none: m.subject_value_none(),
              unlabelled: m.subject_value_unlabelled(),
              sources: m.subject_sources(),
              aliases: m.subject_aliases(),
              search: m.search_submit(),
            }}
          />
        </div>
      </FeatureSlotsProvider>
    </PatternStory>
  );
}
export const Empty: Story = {
  render: () => <PurchasePattern />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="subject-purchase"]')).toBeNull();
    await expect(within(canvasElement).getByRole('heading', { level: 1 })).toBeVisible();
  },
};
export const Populated: Story = {
  render: () => <PurchasePattern populated />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-slot="subject-purchase"]')).toHaveLength(1);
    await expect(
      canvasElement.querySelector('[data-slot="subject-header"] [data-owner-purchase-region]'),
    ).toBeVisible();
  },
};
export const PrivatePending: Story = {
  render: () => <PurchasePattern populated privateOnly />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-owner-purchase-region]')).toBeNull();
  },
};
