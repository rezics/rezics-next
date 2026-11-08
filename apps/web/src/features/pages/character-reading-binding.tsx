import { useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { OverviewContext } from './overview-context';
import { holderItems } from './overview-holder-items';
import { CoverList } from './cover-list';
import { CandidateValue } from './scalar-value';
import { SpoilerGate } from './values';
import { createConnectionWindow, connectionReturn } from './subject-connections-window';
import { connectionReturnHref, withSubjectVisitReturn } from './subject-visit-navigation';
import { relationTargetHref } from './edition-work';
import { CONNECTION_LIMIT } from './subject-connections-contract';
import { subjectViewHref } from '../../subject/load-subject';
import {
  CharacterReadingProvider,
  CharacterReadingSlotsContext,
  CHARACTER_WORK_PAGE_LIMIT,
  type CharacterReadingSlots,
  type CharacterPage,
  type CharacterPageItem,
  type CharacterCoverListProps,
  type CharacterCandidateValueProps,
  type CharacterSpoilerGateProps,
  type CharacterConnectionAddress,
  type CharacterConnectionRead,
  type CharacterConnectionSection,
  type CharacterConnectionPageState,
} from '../catalogue/character-reading-port';
import type { Item, OverviewValue, RowValue } from './overview';
import type { ConnectionAddress, ConnectionSection } from './subject-connections';
import type { ConnectionRead as WindowRead } from './subject-connections-window';

function pageFromOverview(value: OverviewValue | null): CharacterPage | null {
  if (!value) return null;
  const page: CharacterPage = {
    locale: value.locale,
    subject: value.subject,
    link: value.link,
    reader: value.reader,
    labels: value.labels.spoilerHide !== undefined ? { spoilerHide: value.labels.spoilerHide } : {},
    unlabelled: value.unlabelled,
    spoilerShow: value.spoilerShow,
    relations: Object.fromEntries(
      Object.entries(value.relations).map(([id, relation]) => [
        id,
        relation.forwardLabel !== undefined ? { forwardLabel: relation.forwardLabel } : {},
      ]),
    ),
  };
  if (value.currentHref !== undefined) page.currentHref = value.currentHref;
  if (value.context !== undefined) page.context = value.context;
  if (value.realm !== undefined) page.realm = value.realm;
  if (value.cacheReader !== undefined) page.cacheReader = value.cacheReader;
  if (value.subjectLabel !== undefined) page.subjectLabel = value.subjectLabel;
  if (value.releaseDigest !== undefined) page.releaseDigest = value.releaseDigest;
  if (value.candidatePropertyLabel !== undefined) page.candidatePropertyLabel = value.candidatePropertyLabel;
  if (value.relationDirections !== undefined) page.relationDirections = value.relationDirections;
  if (value.relationNodes !== undefined) page.relationNodes = value.relationNodes;
  return page;
}

function itemsFromHolder(
  body: Record<string, unknown>,
  limit: number,
  locale: string,
  level: number,
): CharacterPageItem[] {
  return (holderItems(body, limit, locale, level)?.items ?? []) as CharacterPageItem[];
}

function BoundCoverList({ items, value, label }: CharacterCoverListProps) {
  return <CoverList items={items as Item[]} value={value as RowValue & { subject?: string | null }} label={label} />;
}

function BoundCandidateValue(props: CharacterCandidateValueProps) {
  return <CandidateValue {...props} />;
}

function BoundSpoilerGate({ label, hideLabel, children }: CharacterSpoilerGateProps) {
  return (
    <SpoilerGate label={label} hideLabel={hideLabel}>
      {children}
    </SpoilerGate>
  );
}

/** Native Search page adapters for Character public preview, credited-work continuation and credit inspection. */
export function createCharacterReadingSlots(): CharacterReadingSlots {
  return {
    page: {
      usePage: () => pageFromOverview(useContext(OverviewContext)),
      itemsFromHolder,
    },
    read: {
      pageLimit: CONNECTION_LIMIT,
      createWindow: (address, read) => createConnectionWindow(address as ConnectionAddress, read as WindowRead),
      connectionReturn: (current, page, focus, holder) =>
        connectionReturn(current as ConnectionSection, page as Parameters<typeof connectionReturn>[1], focus, holder),
    },
    navigation: {
      connectionReturnHref,
      withVisitReturn: withSubjectVisitReturn,
      workHref: (subject, locale, context) => relationTargetHref(subject, locale, context),
      subjectViewHref: (subject, locale, view) => subjectViewHref(subject, locale, view),
    },
    presentation: {
      CoverList: BoundCoverList,
      CandidateValue: BoundCandidateValue,
      SpoilerGate: BoundSpoilerGate,
    },
  };
}

const defaultSlots = createCharacterReadingSlots();

/** Installed beside OverviewContext so Character reading never value-imports page implementations. */
export function CharacterReadingBinding({ slots, children }: { slots?: CharacterReadingSlots; children: ReactNode }) {
  const parent = useContext(CharacterReadingSlotsContext);
  const installed = slots ?? parent ?? defaultSlots;
  const bound = useMemo(() => installed, [installed]);
  return <CharacterReadingProvider slots={bound}>{children}</CharacterReadingProvider>;
}

export function characterReadingPageLimit(): number {
  return CHARACTER_WORK_PAGE_LIMIT;
}

export type CharacterReadingCover = ComponentType<CharacterCoverListProps>;
export type CharacterReadingCandidate = ComponentType<CharacterCandidateValueProps>;
export type CharacterConnectionFactory = (
  address: CharacterConnectionAddress,
  read: CharacterConnectionRead,
) => ReturnType<typeof createConnectionWindow>;
export type CharacterConnectionReturn = (
  current: CharacterConnectionSection,
  page?: CharacterConnectionPageState,
  focus?: string,
  holder?: string,
) => ReturnType<typeof connectionReturn>;
