import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from './messages.ts';
import { type PositionChoice, withPosition } from './position.ts';
import { PositionControl } from './position-control.tsx';
import { type PositionState, positionLabel, positionOptions, progressLabel } from './state.ts';
import { readChooser, readLabels } from './read.ts';
import { namesOf } from '../work-levels/read.ts';

/**
 * The position control for a page of the Zone at `here` (its address without the choice). The choices are links
 * to the same page at another position; the server words them so the control carries no data of its own.
 */
export function PositionBar({ state, here, locale }: { state: PositionState; here: string; locale: UiLocale }) {
  const t = copyOf(locale);
  const note = state.mode === 'chosen' ? t.chosen : state.own === null ? t.startOfStory : t.yourProgress;
  const choice = (value: PositionChoice) => withPosition(here, value);
  return <PositionControl
    key={`${state.work}:${state.main ?? ''}:${here}:${locale}`}
    locale={locale} nextCursor={state.chooser.nextCursor}
    load={async cursor => {
      'use server';
      const read = await readChooser(state.work, state.main, cursor);
      if (!read.ok) throw new Error('Reading positions unavailable');
      const names = await namesOf([state.work, ...read.data.items.map(item => item.work)]);
      const labels = new Map((await Promise.all([...new Set(read.data.items.map(item => item.structure))]
        .map(structure => readLabels(structure, read.data.items.filter(item => item.structure === structure)
          .map(item => item.occurrence))))).flatMap(map => [...map]));
      return { items: positionOptions({ ...state, chooser: read.data, names, labels }, here, locale), nextCursor: read.data.nextCursor ?? null };
    }}
    copy={{ region: t.region, upTo: t.upTo, upToEverything: t.upToEverything,
      showEverything: t.showEverything, sheetTitle: t.sheetTitle, sheetBody: t.sheetBody,
      progressOption: t.progressOption, progressNote: t.progressNote, progressNoneNote: t.progressNoneNote,
      everythingOption: t.everythingOption, everythingNote: t.everythingNote, moreChapters: t.moreChapters,
      close: t.close }}
    at={state.mode === 'all' ? { kind: 'all' } : { kind: 'position', label: positionLabel(state, locale), note }}
    options={positionOptions(state, here, locale)}
    progress={{ href: choice({ kind: 'default' }), current: state.mode === 'default', resolved: progressLabel(state, locale) }}
    everything={{ href: choice({ kind: 'all' }), current: state.mode === 'all' }}
    more={state.chooser.more} />;
}
