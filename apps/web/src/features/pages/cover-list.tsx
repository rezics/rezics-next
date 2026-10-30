import {
  fallbackListFactProperties,
  fallbackListPresentation,
  parseListPresentation,
  sharedRatio,
  type ListPresentation,
} from '@rezics/ui/cover';
import { MetaLine, metaText } from '@rezics/ui/meta-line';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { listKeyFacts } from '../../media/type-presentation';
import type { Fact } from '../../search/results';
import { subjectHref } from '../../subject/subject-href';
import type { Item, RowValue } from './overview';
import { SpoilerGate } from './values';

/** One related subject as a card: its own Type presentation, cover, title and one secondary line. */
function ItemCard({
  item,
  value,
  listPresentationFor,
  facts,
}: {
  item: Item;
  value: RowValue;
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  facts?: Readonly<Record<string, readonly Fact[]>>;
}) {
  const title = item.label.text || value.unlabelled;
  const subject = coverSubject(item.id, title, item.summary, item.type);
  const releasedPresentation = parseListPresentation(listPresentationFor?.(subject.types));
  const listPresentation = releasedPresentation ?? fallbackListPresentation(subject.types);
  const keyFacts = listKeyFacts(
    facts,
    releasedPresentation?.keyFacts ?? fallbackListFactProperties(subject.types),
    [],
    value.locale,
  );
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
      {...(keyFacts.length > 0
        ? {
            secondary: (
              <MetaLine
                items={[
                  ...keyFacts.map((fact, index) => (
                    <span key={index} lang={fact.lang} data-property={fact.property}>
                      {fact.text}
                    </span>
                  )),
                  ...item.notes,
                ]}
              />
            ),
          }
        : item.notes.length > 0
          ? { secondary: metaText(item.notes) }
          : {})}
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
  memberFacts,
}: {
  items: Item[];
  value: RowValue;
  label: string;
  preview?: boolean;
  /** Optional adapter for a presentation already resolved from the current released Type hierarchy. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  /** Already supplied current-page facts by member ID. No fact producer or per-member read is implied. */
  memberFacts?: Readonly<Record<string, Readonly<Record<string, readonly Fact[]>>>>;
}) {
  const ratio =
    value.ratio ?? sharedRatio(items.map((item) => coverSubject(item.id, item.label.text, item.summary, item.type)));
  const cards = items.map((item, index) => {
    const facts = memberFacts && Object.hasOwn(memberFacts, item.id) ? memberFacts[item.id] : undefined;
    return (
      <ItemCard
        key={`${item.id}-${index}`}
        item={item}
        value={value}
        {...(listPresentationFor ? { listPresentationFor } : {})}
        {...(facts ? { facts } : {})}
      />
    );
  });
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
