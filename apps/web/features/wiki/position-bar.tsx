import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { ContinuitySwitch } from './continuity-switch.tsx';
import type { ZoneContinuity } from './zone-continuity.ts';
import { copyOf } from './messages.ts';
import { type PositionChoice, withPosition } from './position.ts';
import { PositionControl } from './position-control.tsx';
import { type PositionState, positionLabel, positionOptions, progressLabel } from './state.ts';
import { reader } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';

/**
 * The position control for a page of the Zone at `here` (its address without the choice). The choices are links
 * to the same page at another position; the server words them so the control carries no data of its own.
 */
export async function PositionBar({
  state,
  here,
  locale,
  continuity,
}: {
  state: PositionState;
  here: string;
  locale: UiLocale;
  /** The continuity switch, beside the position, for a Zone whose package offers one. */
  continuity?: ZoneContinuity | null;
}) {
  const t = copyOf(locale);
  const note =
    state.mode === 'chosen' ? t.chosen : state.own === null ? t.startOfStory : t.yourProgress;
  const choice = (value: PositionChoice) => withPosition(here, value);
  const { work, main, mode, at } = state;
  const current = mode === 'chosen' && at ? idOf(at) : null;
  const { actingSubject } = await reader();
  return (
    <PositionControl
      key={`${state.work}:${state.main ?? ''}:${here}:${locale}`}
      locale={locale}
      search={{ work, position: main, actingSubject, here, current }}
      copy={{
        region: t.region,
        upTo: t.upTo,
        upToEverything: t.upToEverything,
        showEverything: t.showEverything,
        sheetTitle: t.sheetTitle,
        sheetBody: t.sheetBody,
        progressOption: t.progressOption,
        progressNote: t.progressNote,
        progressNoneNote: t.progressNoneNote,
        everythingOption: t.everythingOption,
        everythingNote: t.everythingNote,
        moreChapters: t.moreChapters,
        close: t.close,
      }}
      at={
        state.mode === 'all'
          ? { kind: 'all' }
          : { kind: 'position', label: positionLabel(state, locale), note }
      }
      options={positionOptions(state, here, locale)}
      progress={{
        href: choice({ kind: 'default' }),
        current: state.mode === 'default',
        resolved: progressLabel(state, locale),
      }}
      everything={{ href: choice({ kind: 'all' }), current: state.mode === 'all' }}
      more={state.chooser.more}
    >
      {continuity && continuity.options.length ? (
        <ContinuitySwitch
          here={here}
          current={continuity.choice}
          fallback={continuity.fallback}
          options={continuity.options}
          locale={locale}
          messages={await getMessages('scopedRating', locale)}
        />
      ) : null}
    </PositionControl>
  );
}
