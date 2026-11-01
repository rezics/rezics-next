import {
  fallbackListFactProperties,
  fallbackListPresentation,
  parseListPresentation,
  sharedRatio,
  type ListPresentation,
} from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { listKeyFacts } from '../../media/type-presentation';
import type { Fact } from '../../search/results';
import { relationTargetHref } from './edition-work';
import type { Item, RowValue } from './overview';
import { QualifiedCredit } from './qualified-credit';
import { SpoilerGate } from './values';

/** One current relation, keeping full credit facts separate from ordinary card metadata. */
function ItemCard({
  item,
  value,
  listPresentationFor,
  facts,
  credit = false,
}: {
  item: Item;
  value: RowValue;
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  facts?: Readonly<Record<string, readonly Fact[]>>;
  credit?: boolean;
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
  const notes = [
    ...keyFacts.map((fact, index) => (
      <span key={index} lang={fact.lang} data-property={fact.property}>
        {fact.text}
      </span>
    )),
    ...item.notes,
  ];
  const cover = {
    subject,
    cover: coverOf(item.summary),
    src: coverSrc,
    ...(listPresentation ? { listPresentation } : {}),
    suitability: value.reader.suitability,
    labels: value.labels.cover,
  };
  const href = relationTargetHref({ id: item.id, label: title }, value.locale, value.context);
  const card = credit ? (
    <QualifiedCredit
      title={title}
      titleLang={item.label.lang}
      href={href}
      cover={cover}
      notes={notes}
      qualified={item.qualified ?? []}
      value={value}
    />
  ) : (
    <CoverCard
      link={value.link}
      href={href}
      title={title}
      {...(item.label.lang ? { titleLang: item.label.lang } : {})}
      cover={cover}
      {...(notes.length > 0 ? { secondary: <MetaLine items={notes} /> } : {})}
    />
  );
  return item.gated ? <SpoilerGate label={value.spoilerShow}>{card}</SpoilerGate> : card;
}

/**
 * Qualified credits stay semantic rows at every width and use their shared card as the visual frame. Ordinary
 * subjects remain cards with their Type's list frame. The shared ratio is the fallback for unknown Types; a Zone's
 * appearance fixes that composition. Ordinary card previews snap on phones and use a grid from `sm` up. `label`
 * names the list for assistive technology.
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
  const credits = items.some((item) => (item.qualified?.length ?? 0) > 0);
  const cards = items.map((item, index) => {
    const facts = memberFacts && Object.hasOwn(memberFacts, item.id) ? memberFacts[item.id] : undefined;
    const card = (
      <ItemCard
        key={`${item.id}-${index}`}
        item={item}
        value={value}
        credit={credits}
        {...(listPresentationFor ? { listPresentationFor } : {})}
        {...(facts ? { facts } : {})}
      />
    );
    return credits ? (
      <li key={`${item.id}-${index}`}>
        <div data-statement={item.statement}>{card}</div>
      </li>
    ) : (
      card
    );
  });
  if (credits) {
    return (
      <div className="@container">
        <ul aria-label={label} className="grid min-w-0 gap-6 @2xl:grid-cols-2">
          {cards}
        </ul>
      </div>
    );
  }
  return (
    <>
      {preview && (
        <div data-layout="cover-row" className="sm:hidden">
          <CoverRow ratio={ratio} label={label} role="group">
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
