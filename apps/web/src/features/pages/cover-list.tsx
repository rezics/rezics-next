import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { CreditAssertion, CreditVisit } from '../catalogue/credit-inspection/model';
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

const CreditInspectionSession = lazy(() =>
  import('../catalogue/credit-inspection/session').then((module) => ({
    default: module.CreditInspectionSession,
  })),
);

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
  link,
  listPresentationFor,
  facts,
  credit = false,
  openExactEdition = false,
  catalogue,
  inspect,
}: {
  item: Item;
  value: RowValue;
  link?: RowValue['link'];
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  facts?: Readonly<Record<string, readonly Fact[]>>;
  credit?: boolean;
  openExactEdition?: boolean;
  catalogue?: CatalogueRowContext;
  inspect?: (trigger: HTMLButtonElement) => void;
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
      openInNewTab={exactEdition || !!inspect}
      inspection={
        inspect ? (
          <Button variant="outline" className="mt-2" onClick={(event) => inspect(event.currentTarget)}>
            {m.credit_inspect({}, { locale: value.locale as never })}
          </Button>
        ) : undefined
      }
    />
  ) : (
    <CoverCard
      link={
        link ??
        (catalogue
          ? (props) => <CatalogueTargetLink {...props} locale={value.locale} />
          : exactEdition
            ? ExactEditionLink
            : value.link)
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
  const cardWithSupport = item.supportSlot ? (
    <div className="min-w-0 space-y-2">
      {card}
      {!item.gated ? item.supportSlot : null}
    </div>
  ) : (
    card
  );
  // Only rendered facts and the resolved presentation matter, not adapter function identity or unused facts.
  const disclosure = contentIdentity([keyFacts, listPresentation]);
  return item.gated ? (
    <SpoilerGate key={disclosure} label={value.spoilerShow} hideLabel={value.labels.spoilerHide}>
      {cardWithSupport}
    </SpoilerGate>
  ) : (
    cardWithSupport
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
  itemVisit,
  preview = false,
  listPresentationFor,
  memberFacts,
  openExactEditions = false,
  memberCatalogue,
  creditVisit,
}: {
  items: Item[];
  value: RowValue & { subject?: string | null };
  label: string;
  /** Optional per-row destination and disclosed assertion focus for bounded visit adapters. */
  itemVisit?: (item: Item) => { link?: RowValue['link']; holder?: string; details?: ReactNode } | undefined;
  preview?: boolean;
  /** Optional adapter for a presentation already resolved from the current released Type hierarchy. */
  listPresentationFor?: (types: readonly string[]) => ListPresentation | undefined;
  /** Already supplied current-page facts by member ID. No fact producer or per-member read is implied. */
  memberFacts?: Readonly<Record<string, Readonly<Record<string, readonly Fact[]>>>>;
  /** Open only exact released bf:Instance destinations in a separate tab. */
  openExactEditions?: boolean;
  /** Current native TypeList rows only; this public seam never carries personal state or actions. */
  memberCatalogue?: Readonly<Record<string, CatalogueRowContext>>;
  creditVisit?: CreditVisit | undefined;
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
  const visitIdentity = contentIdentity([creditVisit, disclosure]);
  const visitOwner = useRef({ identity: visitIdentity });
  if (visitOwner.current.identity !== visitIdentity) visitOwner.current = { identity: visitIdentity };
  const owner = visitOwner.current;
  const [inspection, setInspection] = useState<{
    owner: object;
    identity: string;
    credit: CreditAssertion;
    visit: CreditVisit;
    title: string;
    trigger: HTMLButtonElement;
  }>();
  const liveInspection =
    inspection?.owner === owner && items.some((item) => contentIdentity(item) === inspection.identity)
      ? inspection
      : undefined;
  function closeInspection() {
    if (visitOwner.current !== owner || !liveInspection) return;
    const trigger = liveInspection.trigger;
    setInspection(undefined);
    if (trigger.isConnected) trigger.focus();
  }
  const inspector = liveInspection ? (
    <Suspense fallback={<p role="status">{m.candidate_loading({}, { locale: value.locale as never })}</p>}>
      <CreditInspectionSession
        key={liveInspection.identity}
        id={liveInspection.visit.person}
        address={visitIdentity}
        credit={liveInspection.credit}
        visit={liveInspection.visit}
        title={liveInspection.title}
        propertyLabel={liveInspection.visit.propertyLabel}
        locale={value.locale}
        onClose={closeInspection}
        returnFocus={() =>
          visitOwner.current === owner && liveInspection.trigger.isConnected ? liveInspection.trigger : null
        }
      />
    </Suspense>
  ) : null;
  const credits = !!creditVisit || items.some((item) => (item.qualified?.length ?? 0) > 0);
  const occurrences = new Map<string, number>();
  const cards = items.map((item) => {
    // Item has no revision field: compare its delivered content even when a statement ID is reused.
    // Count only identical occurrences, so distinct statements to the same target survive reordering.
    const publicItem = Object.fromEntries(Object.entries(item).filter(([field]) => field !== 'supportSlot'));
    const identity = contentIdentity([publicItem, disclosure]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = `${identity}:${occurrence}`;
    const visit = itemVisit?.(item);
    const facts = memberFacts && Object.hasOwn(memberFacts, item.id) ? memberFacts[item.id] : undefined;
    const card = (
      <ItemCard
        key={key}
        item={item}
        value={value}
        {...(visit?.link ? { link: visit.link } : {})}
        credit={credits}
        {...(item.credit && creditVisit
          ? {
              inspect: (trigger: HTMLButtonElement) => {
                if (visitOwner.current !== owner) return;
                setInspection({
                  owner,
                  identity: contentIdentity(item),
                  credit: item.credit!,
                  visit: creditVisit,
                  title: item.label.text || value.unlabelled,
                  trigger,
                });
              },
            }
          : {})}
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
      <div
        key={key}
        role="listitem"
        data-statement={item.statement}
        {...(item.statement && visit?.holder
          ? { 'data-connection-statement': item.statement, 'data-connection-holder': visit.holder }
          : {})}
        className="min-w-0"
      >
        {card}
        {visit?.details}
      </div>
    );
  });
  if (credits) {
    return (
      <div className="@container">
        <ul aria-label={label} className="grid min-w-0 gap-6 @2xl:grid-cols-2">
          {cards}
        </ul>
        {inspector}
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
