import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import type { Item, RowValue } from './overview';
import { SpoilerGate } from './values';

/** One related subject as a card: its cover, its title and one secondary line. */
function ItemCard({ item, value }: { item: Item; value: RowValue }) {
  const title = item.label.text || value.unlabelled;
  const card = (
    <CoverCard
      link={value.link}
      href={`/${encodeURIComponent(value.locale)}/subjects/${encodeURIComponent(item.id)}`}
      title={title}
      {...(item.label.lang ? { titleLang: item.label.lang } : {})}
      cover={{
        subject: coverSubject(item.id, title, item.summary, item.type),
        cover: coverOf(item.summary),
        src: coverSrc,
        suitability: value.reader.suitability,
        labels: value.labels.cover,
      }}
      {...(item.notes.length > 0 ? { secondary: item.notes.join(' · ') } : {})}
    />
  );
  return item.gated ? <SpoilerGate label={value.spoilerShow}>{card}</SpoilerGate> : card;
}

/**
 * The subjects of one list as cover cards sharing a frame ratio, so a mixed list stays aligned; a Zone's appearance
 * fixes it. A preview is one snapping row on a phone and a grid from `sm` up; a full view is a grid at every width.
 * `label` names the row for assistive technology.
 */
export function CoverList({
  items,
  value,
  label,
  preview = false,
}: {
  items: Item[];
  value: RowValue;
  label: string;
  preview?: boolean;
}) {
  const ratio =
    value.ratio ?? sharedRatio(items.map((item) => coverSubject(item.id, item.label.text, item.summary, item.type)));
  const cards = items.map((item, index) => <ItemCard key={`${item.id}-${index}`} item={item} value={value} />);
  return (
    <>
      {preview && (
        <div data-slot="cover-row" className="sm:hidden">
          <CoverRow ratio={ratio} label={label}>
            {cards}
          </CoverRow>
        </div>
      )}
      <div data-slot="cover-grid" className={preview ? 'hidden sm:block' : undefined}>
        <CoverGrid ratio={ratio}>{cards}</CoverGrid>
      </div>
    </>
  );
}
