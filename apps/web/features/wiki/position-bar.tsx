import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from './messages.ts';
import { type PositionChoice, withPosition } from './position.ts';
import { PositionControl } from './position-control.tsx';
import { type PositionState, positionLabel, positionOptions, progressLabel } from './state.ts';

/**
 * The position control for a page of the Zone at `here` (its address without the choice). The choices are links
 * to the same page at another position; the server words them so the control carries no data of its own.
 */
export function PositionBar({ state, here, locale }: { state: PositionState; here: string; locale: UiLocale }) {
  const t = copyOf(locale);
  const note = state.mode === 'chosen' ? t.chosen : state.own === null ? t.startOfStory : t.yourProgress;
  const choice = (value: PositionChoice) => withPosition(here, value);
  return <PositionControl
    copy={{ region: t.region, upTo: t.upTo, upToEverything: t.upToEverything, change: t.change,
      showEverything: t.showEverything, sheetTitle: t.sheetTitle, sheetBody: t.sheetBody,
      progressOption: t.progressOption, progressNote: t.progressNote, progressNoneNote: t.progressNoneNote,
      everythingOption: t.everythingOption, everythingNote: t.everythingNote, moreChapters: t.moreChapters,
      close: t.close }}
    at={state.mode === 'all' ? { kind: 'all' } : { kind: 'position', label: positionLabel(state), note }}
    options={positionOptions(state, here)}
    progress={{ href: choice({ kind: 'default' }), current: state.mode === 'default', resolved: progressLabel(state) }}
    everything={{ href: choice({ kind: 'all' }), current: state.mode === 'all' }}
    more={state.chooser.more} />;
}
