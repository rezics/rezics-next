import type { Copy } from './messages.ts';
import type { SeriesSummary } from './types.ts';

type States = SeriesSummary['states'];

// One line for each state Main returned, in Main's order, each with its own value. The table is typed
// over Main's states, so a state added to the contract breaks this build instead of going unshown.
const stateLabels: Record<keyof States, (t: Copy) => string> = {
  caughtUpWithAvailableMaterial: t => t.stateCaughtUp,
  finishedPublishedParts: t => t.stateFinishedParts,
  seriesConcluded: t => t.stateConcluded,
  correspondenceUnresolved: t => t.stateCorrespondence,
};

const valueText = (value: boolean | null, t: Copy) => (value === null ? t.unknown : value ? t.yes : t.no);

/** Main's progress states, never merged or inferred: "caught up" and "finished" are different lines. */
export function SeriesStates({ states, t }: { states: States; t: Copy }) {
  const keys = (Object.keys(states) as (keyof States)[]).filter(key => key in stateLabels);
  return <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm" aria-label={t.seriesProgress}>
    {keys.map(key => <div key={key} className="contents" data-state={key} data-value={String(states[key])}>
      <dt className="text-muted-foreground">{stateLabels[key](t)}</dt>
      <dd className="font-medium">{valueText(states[key], t)}</dd>
    </div>)}
  </dl>;
}
