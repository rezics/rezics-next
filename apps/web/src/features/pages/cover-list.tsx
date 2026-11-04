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
import type { LinkProps } from './shared';
import { CatalogueSecondary, CatalogueTargetLink } from './catalogue-list-context/secondary';
import { catalogueText, type CatalogueRowContext } from './catalogue-list-context/model';

export function ExactEditionLink({ href, lang, className, children }: LinkProps) {
  return (
    <a href={href} lang={lang} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function isExactEdition(item: Item): boolean {
  return item.type === 'bf:Instance' || item.summary?.types?.includes('bf:Instance') === true;
}

/** DTO object allocation and member order do not change an accepted relation's content. */
function contentIdentity(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) =>
    part && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : part,
  );
}

/** One current relation, keeping full credit facts separate from ordinary card metadata. */
function ItemCard({
  item,
  value,
  listPresentationFor,
  facts,
  credit = false,
  openExactEdition = false,
  catalogue,
}: {
  item: Item;
  value: RowValue;
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  facts?: Readonly<Record<string, readonly Fact[]>>;
  credit?: boolean;
  openExactEdition?: boolean;
  catalogue?: CatalogueRowContext;
}) {
  const title = item.label.text || value.unlabelled;
  const subject = coverSubject(item.id, title, item.summary, item.type);
  const releasedPresentation = catalogue?.presentation ?? parseListPresentation(listPresentationFor?.(subject.types));
  const listPresentation = releasedPresentation ?? fallbackListPresentation(subject.types);
  const keyFacts = listKeyFacts(
    catalogue?.facts ?? facts,
    releasedPresentation?.keyFacts ?? fallbackListFactProperties(subject.types),
    [],
    value.locale,
  );
  const notes = [
    ...keyFacts.map((fact, index) => (
      <span key={index} lang={fact.lang} data-property={fact.property}>
        {catalogue ? catalogueText(fact.text) : fact.text}
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
  const exactEdition = openExactEdition && isExactEdition(item);
  const secondary = notes.length > 0 ? <MetaLine items={notes} /> : null;
  const card = credit ? (
    <QualifiedCredit
      title={title}
      titleLang={item.label.lang}
      href={href}
      cover={cover}
      notes={notes}
      qualified={item.qualified ?? []}
      value={value}
      openInNewTab={exactEdition}
    />
  ) : (
    <CoverCard
      link={
        catalogue
          ? (props) => <CatalogueTargetLink {...props} locale={value.locale} />
          : exactEdition
            ? ExactEditionLink
            : value.link
      }
      {...(!catalogue || catalogue.context.target ? { href } : {})}
      title={title}
      {...(item.label.lang ? { titleLang: item.label.lang } : {})}
      cover={cover}
      secondary={
        catalogue ? (
          <CatalogueSecondary context={catalogue.context} title={title} value={value} nativeFacts={secondary} />
        ) : (
          secondary
        )
      }
    />
  );
  // Only rendered facts and the resolved presentation matter, not adapter function identity or unused facts.
  const disclosure = contentIdentity([keyFacts, listPresentation]);
  return item.gated ? (
    <SpoilerGate key={disclosure} label={value.spoilerShow} hideLabel={value.labels.spoilerHide}>
      {card}
    </SpoilerGate>
  ) : (
    card
  );
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
  openExactEditions = false,
  memberCatalogue,
}: {
  items: Item[];
  value: RowValue & { subject?: string | null };
  label: string;
  preview?: boolean;
  /** Optional adapter for a presentation already resolved from the current released Type hierarchy. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  /** Already supplied current-page facts by member ID. No fact producer or per-member read is implied. */
  memberFacts?: Readonly<Record<string, Readonly<Record<string, readonly Fact[]>>>>;
  /** Open only exact released bf:Instance destinations in a separate tab. */
  openExactEditions?: boolean;
  /** Current native TypeList rows only; this public seam never carries personal state or actions. */
  memberCatalogue?: Readonly<Record<string, CatalogueRowContext>>;
}) {
  const context = value.context;
  const disclosure = [
    value.subject,
    context?.id,
    context?.population.kind,
    context?.population.kind === 'realm' ? context.population.id : undefined,
    value.locale,
    value.reader.spoilerLevel,
    value.reader.suitability,
    value.unlabelled,
  ];
  const ratio =
    value.ratio ?? sharedRatio(items.map((item) => coverSubject(item.id, item.label.text, item.summary, item.type)));
  const credits = items.some((item) => (item.qualified?.length ?? 0) > 0);
  const occurrences = new Map<string, number>();
  const cards = items.map((item) => {
    // Item has no revision field: compare its delivered content even when a statement ID is reused.
    // Count only identical occurrences, so distinct statements to the same target survive reordering.
    const identity = contentIdentity([item, disclosure]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = `${identity}:${occurrence}`;
    const facts = memberFacts && Object.hasOwn(memberFacts, item.id) ? memberFacts[item.id] : undefined;
    const card = (
      <ItemCard
        key={key}
        item={item}
        value={value}
        credit={credits}
        openExactEdition={openExactEditions}
        {...(memberCatalogue && Object.hasOwn(memberCatalogue, item.id) ? { catalogue: memberCatalogue[item.id] } : {})}
        {...(listPresentationFor ? { listPresentationFor } : {})}
        {...(facts ? { facts } : {})}
      />
    );
    return credits ? (
      <li key={key}>
        <div data-statement={item.statement}>{card}</div>
      </li>
    ) : (
      <div key={key} role="listitem" data-statement={item.statement} className="min-w-0">
        {card}
      </div>
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
        <div data-layout="cover-row" role="list" aria-label={label} className="sm:hidden">
          <CoverRow ratio={ratio} label={label} role="group">
            {cards}
          </CoverRow>
        </div>
      )}
      <div data-layout="cover-grid" role="list" aria-label={label} className={preview ? 'hidden sm:block' : undefined}>
        <CoverGrid ratio={ratio}>{cards}</CoverGrid>
      </div>
    </>
  );
}
