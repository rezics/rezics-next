import { sharedRatio } from '@rezics/ui/cover';
import { fallbackListPresentation, type ListPresentation } from '@rezics/ui/cover';
import { metaText } from '@rezics/ui/meta-line';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { subjectHref } from '../../subject/subject-href';
import type { Item, RowValue } from './overview';
import { SpoilerGate } from './values';

/** One related subject as a card: its own Type presentation, cover, title and one secondary line. */
function ItemCard({
  item,
  value,
  listPresentationFor,
}: {
  item: Item;
  value: RowValue;
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
}) {
  const title = item.label.text || value.unlabelled;
  const subject = coverSubject(item.id, title, item.summary, item.type);
  const listPresentation = listPresentationFor?.(subject.types) ?? fallbackListPresentation(subject.types);
  const card = (
    <CoverCard
      link={value.link}
      href={subjectHref({ id: item.id, label: title }, value.locale).href}
      title={title}
      {...(item.label.lang ? { titleLang: item.label.lang } : {})}
      cover={{
        subject,
        cover: coverOf(item.summary),
        src: coverSrc,
        ...(listPresentation ? { listPresentation } : {}),
        suitability: value.reader.suitability,
        labels: value.labels.cover,
      }}
      {...(item.notes.length > 0 ? { secondary: metaText(item.notes) } : {})}
    />
  );
  return item.gated ? <SpoilerGate label={value.spoilerShow}>{card}</SpoilerGate> : card;
}

/**
 * The subjects of one list as cards. Each known member keeps its Type's list frame; the shared ratio is the fallback
 * composition for unknown Types. A Zone's appearance fixes that composition. A preview is one snapping row on a phone
 * and a grid from `sm` up; a full view is a grid at every width. `label` names the row for assistive technology.
 */
export function CoverList({
  items,
  value,
  label,
  preview = false,
  listPresentationFor,
}: {
  items: Item[];
  value: RowValue;
  label: string;
  preview?: boolean;
  /** Optional adapter for a presentation already resolved from the current released Type hierarchy. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
}) {
  const ratio =
    value.ratio ?? sharedRatio(items.map((item) => coverSubject(item.id, item.label.text, item.summary, item.type)));
  const cards = items.map((item, index) => (
    <ItemCard key={`${item.id}-${index}`} item={item} value={value} listPresentationFor={listPresentationFor} />
  ));
  return (
    <>
      {preview && (
        <div data-layout="cover-row" className="sm:hidden">
          <CoverRow ratio={ratio} label={label}>
            {cards}
          </CoverRow>
        </div>
      )}
      <div data-layout="cover-grid" className={preview ? 'hidden sm:block' : undefined}>
        <CoverGrid ratio={ratio}>{cards}</CoverGrid>
      </div>
    </>
  );
}
