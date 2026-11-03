import { m } from '../paraglide/messages.js';
import {
  groupSelectionResults,
  selectionResultStates,
  type SelectionResultItem,
  type SelectionResultState,
} from './selection-review';

const resultLabel: Record<SelectionResultState, () => string> = {
  applied: m.library_bulk_status_applied,
  no_effect: m.library_bulk_status_no_change,
  conflict: m.library_bulk_status_conflict,
  denied: m.library_bulk_status_denied,
  cancelled: m.library_bulk_status_cancelled,
  failed: m.library_bulk_status_failed,
  pending: m.library_bulk_status_pending,
  uncertain: m.library_bulk_status_reconciling,
};

export function SelectionResultView({ results }: { results: readonly SelectionResultItem[] }) {
  if (!results.length) return null;
  const groups = groupSelectionResults(results);
  return (
    <section className="space-y-3" aria-label={m.library_selection_results()}>
      <h3 className="font-medium">{m.library_selection_results()}</h3>
      {selectionResultStates.map((state) => {
        const items = groups[state];
        if (!items.length) return null;
        const label = resultLabel[state]();
        return (
          <section key={state} data-selection-result-group={state}>
            <h4 className="font-medium">
              {m.library_bulk_status_result_count({ status: label, count: items.length })}
            </h4>
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.key}
                  data-selection-result-state={state}
                  {...(item.source === 'bulk-status' ? { 'data-bulk-status-outcome': item.sourceState } : {})}
                  {...(item.source === 'bulk-removal' ? { 'data-bulk-library-removal-outcome': item.sourceState } : {})}
                >
                  <span className="font-medium">{item.title}</span>{' '}
                  <code className="break-all text-xs text-muted-foreground">{item.subjectId}</code>
                  {item.detail ? <span>: {item.detail}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
