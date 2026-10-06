import type { ZonePackage, ZonePositionState, ZoneText } from '@rezics/zone-sdk';
import { cache } from 'react';
import { zoneText } from '../realm/adapt.ts';
import { namesOf } from '../work-levels/read.ts';
import type { Names } from '../work-levels/types.ts';
import { idOf } from '../work-page/route.ts';
import { type PositionChoice, mainPosition, positionParam, withPosition } from './position.ts';
import {
  type Chooser,
  type ChooserItem,
  type OccurrenceLabel,
  readChooser,
  readLabels,
  readPositionedRoute,
} from './read.ts';
import { pickPositionLabel } from './position-picker.ts';

// Where this reader reads up to, resolved once per request for a Zone whose package asks for positions
// (`ZonePackage.positions`). Main decides what each read returns for the position it is given; this file chooses
// which position that is and words it.

/** The Work whose reading order the Zone's positions are in, and what the reader's position resolves to. */
export interface PositionState {
  choice: PositionChoice;
  /** The `position` every Main read sends, or undefined for Main's own default (a reader with progress). */
  main: string | undefined;
  /** `default` is the reader's own progress or the start of the story, `chosen` a position they picked. */
  mode: 'default' | 'chosen' | 'all';
  work: string;
  chooser: Chooser;
  /** Names of the Works the positions are in (a volume); a chapter's own name is its label. */
  names: Names;
  /** The labels the compositions give their occurrences (`Chapter 3`), by occurrence IRI. */
  labels: ReadonlyMap<string, OccurrenceLabel[]>;
  /** The occurrence the reads are up to; null for `all`. */
  at: string | null;
  /** The reader's own furthest finished chapter, whatever they chose to look at; null before they finish one. */
  own: string | null;
}

const rootMount = (segment: string) => `/${segment}`;

/**
 * The reader's position: the one in the address, else Main's default for them. A reader with no finished chapter
 * has none, and Main then withholds every record that has a position, so the story's first chapter is where they
 * start (the control says so and offers the rest).
 */
export const loadPosition = cache(
  async (zone: string, mount: string, choiceKey: string): Promise<PositionState | null> => {
    const choice: PositionChoice =
      choiceKey === 'all'
        ? { kind: 'all' }
        : choiceKey
          ? { kind: 'at', occurrence: choiceKey }
          : { kind: 'default' };
    const works = await readPositionedRoute(zone, rootMount(mount), undefined, undefined);
    if (!works.ok || works.data.kind !== 'index') return null;
    const first = works.data.items.find((item) => 'title' in item);
    if (!first) return null;
    const chooser = await readChooser(first.id, mainPosition(choice));
    if (!chooser.ok) return null;
    const { resolved, items } = chooser.data;
    const start = items.find((item) => item.role === 'chapter') ?? items[0];
    let main = mainPosition(choice);
    let at: string | null = resolved === 'all' || resolved === 'start' ? null : resolved;
    if (choice.kind === 'default' && resolved === 'start' && start) {
      main = start.occurrence;
      at = start.occurrence;
    }
    // What Main would use for the reader on their own: their progress is a choice the control always offers.
    const own =
      choice.kind === 'default'
        ? chooser.data
        : await readChooser(first.id, undefined).then((read) => (read.ok ? read.data : null));
    const progress =
      own && own.resolved !== 'start' && own.resolved !== 'all' ? own.resolved : null;
    const positions = [
      ...new Set([
        ...items.map((item) => item.occurrence),
        ...(at ? [at] : []),
        ...(progress ? [progress] : []),
      ]),
    ];
    const [names, composed] = await Promise.all([
      namesOf([chooser.data.work, ...items.map((item) => item.work)]),
      Promise.all(
        [...new Set(items.map((item) => item.structure))].map((structure) =>
          readLabels(structure, positions),
        ),
      ),
    ]);
    const labels = new Map(composed.flatMap((map) => [...map]));
    return {
      choice,
      main,
      mode: choice.kind === 'default' ? 'default' : choice.kind === 'all' ? 'all' : 'chosen',
      work: chooser.data.work,
      chooser: chooser.data,
      names,
      labels,
      at,
      own: progress,
    };
  },
);

/** The Work a package's positions are in is the first Work its `positions.mount` lists. */
export const positionOf = (pkg: Pick<ZonePackage, 'positions'> | null, zone: string, choice: PositionChoice) =>
  pkg?.positions
    ? loadPosition(zone, pkg.positions.mount, positionParam(choice) ?? '')
    : Promise.resolve(null);

function nameText(names: Names, reference: string): ZoneText | null {
  const summary = names.get(reference);
  return summary?.status === 'available' ? zoneText(summary.name) : null;
}

/** The label to read in `locale`: its own language, else the same base language, else English, else the first written. */
export const pickLabel = pickPositionLabel;

/** The name of a chapter (an occurrence): the label its composition gives it. */
export const occurrenceName = (
  state: Pick<PositionState, 'labels'>,
  occurrence: string,
  locale: string,
) => pickLabel(state.labels.get(occurrence), locale);

/** An item as the chooser lists it: a part of a larger story says which (`Volume 1 · Chapter 3`). */
export function itemLabel(
  state: Pick<PositionState, 'chooser' | 'names' | 'labels'>,
  item: ChooserItem,
  locale: string,
): ZoneText | null {
  const own = occurrenceName(state, item.occurrence, locale);
  if (!own) return null;
  if (item.work === state.chooser.work) return own;
  const owner = nameText(state.names, item.work);
  return owner ? { ...own, value: `${owner.value} · ${own.value}` } : own;
}

/** The label of an occurrence in the chooser. */
function labelOf(state: PositionState, occurrence: string | null, locale: string): ZoneText | null {
  const item = occurrence
    ? state.chooser.items.find((candidate) => candidate.occurrence === occurrence)
    : undefined;
  return item
    ? itemLabel(state, item, locale)
    : occurrence
      ? occurrenceName(state, occurrence, locale)
      : null;
}

/** The label of the position the reads are up to. */
export const positionLabel = (state: PositionState, locale: string) =>
  labelOf(state, state.at, locale);

/** The label of the reader's own progress, when they have any. */
export const progressLabel = (state: PositionState, locale: string) =>
  labelOf(state, state.own, locale);

/** The slot-facing words for the position: where the reader is, and the address that shows everything. */
export function positionNote(
  state: PositionState | null,
  here: string,
  locale: string,
): ZonePositionState {
  if (!state) return { mode: 'default', label: null, showAllHref: null };
  return {
    mode: state.mode,
    label: positionLabel(state, locale),
    showAllHref: state.mode === 'all' ? null : withPosition(here, { kind: 'all' }),
  };
}

/** The positions to offer, in reading order, each with the address that chooses it. */
export interface PositionOption {
  id: string;
  label: ZoneText;
  href: string;
  current: boolean;
}
export function positionOptions(
  state: PositionState,
  here: string,
  locale: string,
): PositionOption[] {
  const current = state.at ? idOf(state.at) : null;
  return state.chooser.items.flatMap((item) => {
    const label = itemLabel(state, item, locale);
    const id = idOf(item.occurrence);
    return label && id
      ? [
          {
            id,
            label,
            href: withPosition(here, { kind: 'at', occurrence: id }),
            current: state.mode !== 'all' && current === id && state.mode === 'chosen',
          },
        ]
      : [];
  });
}
