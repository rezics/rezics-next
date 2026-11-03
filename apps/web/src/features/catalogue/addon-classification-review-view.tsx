import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import type { CandidateTransport } from '../../subject/candidate-review';
import { CatalogueCurrentReading } from './editor-lifetime';
import { CharacterClassifications } from './character-profile-classification';
import { pageText } from '../pages/shared';
import { addonClassificationProperties, type AddonClassificationCopyPlan } from './addon-classification-review';
import type { FactsCurrent, FactsTransport } from './subject-facts';

export function AddonClassificationIndependence({ locale }: { locale: string }) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p>{m.addon_classification_intro({}, o)}</p>
      <p>{m.addon_classification_independent({}, o)}</p>
      <p>{m.addon_classification_copy_note({}, o)}</p>
    </div>
  );
}

export function AddonClassificationCopySummary({
  plan,
  read,
  locale,
}: {
  plan: AddonClassificationCopyPlan | null;
  read: FactsCurrent;
  locale: string;
}) {
  const o = { locale: locale as never };
  if (!plan) return null;
  return (
    <ul className="min-w-0 space-y-1 text-sm">
      {plan.ineligible.map((item) => (
        <li key={item.holder}>
          {pageText(read.release.properties[item.property]?.labels, locale).text || item.property}
        </li>
      ))}
      {!!plan.eligible.length && <li className="text-muted-foreground">{m.addon_classification_copy_note({}, o)}</li>}
    </ul>
  );
}

export function AddonClassifications({
  read,
  locale,
  search,
  transport,
  review,
  visible = true,
  revision,
}: {
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  visible?: boolean;
  revision?: string;
}) {
  const o = { locale: locale as never };
  const properties = addonClassificationProperties(read);
  return (
    <CatalogueCurrentReading
      visible={visible}
      ready={visible}
      revision={revision ?? `${read.public.subject.id}:addon-classification`}
    >
      <section data-addon-classification className="min-w-0 space-y-4">
        <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5">
          <ContentItemHeading level={2} className="text-lg font-semibold">
            {m.addon_classification_title({}, o)}
          </ContentItemHeading>
          <AddonClassificationIndependence locale={locale} />
        </ContentItemFrame>
        <CharacterClassifications
          changedSetReview
          properties={properties}
          read={read}
          locale={locale}
          search={search}
          transport={transport}
          review={review}
        />
      </section>
    </CatalogueCurrentReading>
  );
}
