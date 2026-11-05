import { useId } from 'react';
import { ProgressRow } from '@rezics/ui/progress-row';
import type { Locale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import type { ProgressLabelInput } from '../progress-label';
import { progressView } from '../progress-label';

function modeText(mode: ProgressLabelInput['mode'], locale: string): string {
  const options = { locale: locale as Locale };
  if (mode === 'scalar_amount') return m.library_progress_mode_amount({}, options);
  if (mode === 'cursor_position') return m.library_progress_mode_cursor({}, options);
  return m.library_progress_mode_units({}, options);
}

function exactAmount(progress: ProgressLabelInput): string | null {
  if (progress.mode === 'completed_units') return String(progress.completedUnitCount);
  if (progress.mode === 'cursor_position') return progress.position ?? null;
  return progress.amount;
}

export function ReceivedEntryProgress({ progress, locale }: { progress: ProgressLabelInput | null; locale: string }) {
  const descriptionId = useId();
  const options = { locale: locale as Locale };
  if (progress === null)
    return (
      <p className="py-4 text-sm text-muted-foreground">{m.library_entry_reading_progress_unavailable({}, options)}</p>
    );

  const view = progressView(progress, locale);
  const amount = exactAmount(progress);
  const meaning =
    progress.mode === 'scalar_amount'
      ? m.library_entry_reading_progress_amount_meaning({}, options)
      : progress.mode === 'cursor_position'
        ? m.library_entry_reading_progress_cursor_meaning({}, options)
        : m.library_entry_reading_progress_units_meaning({}, options);
  return (
    <section
      aria-labelledby="received-entry-progress"
      className="min-w-0 space-y-3 py-4"
      data-entry-reading-progress=""
    >
      <h3 id="received-entry-progress" className="font-medium">
        {m.library_entry_reading_progress_heading({}, options)}
      </h3>
      <p className="break-words font-medium" aria-describedby={descriptionId}>
        {view?.text ?? m.library_entry_reading_value_unavailable({}, options)}
      </p>
      {view?.percent !== null && view?.percent !== undefined ? (
        <ProgressRow value={view.percent / 100} label={view.text} />
      ) : null}
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {m.library_entry_reading_progress_snapshot({}, options)}
      </p>
      <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="break-words text-muted-foreground">{m.library_progress_mode({}, options)}</dt>
        <dd className="min-w-0 break-words">{modeText(progress.mode, locale)}</dd>
        <dt className="break-words text-muted-foreground">{m.library_progress_unit({}, options)}</dt>
        <dd className="min-w-0 break-words" lang={progress.unitLabelLanguage}>
          {progress.unitLabel || m.library_progress_unit_unspecified({}, options)}
        </dd>
        <dt className="break-words text-muted-foreground">
          {progress.mode === 'cursor_position'
            ? m.library_entry_reading_position({}, options)
            : progress.mode === 'completed_units'
              ? m.library_entry_reading_completed_units({}, options)
              : m.library_entry_reading_amount({}, options)}
        </dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {amount === null ? m.library_entry_reading_value_unavailable({}, options) : <bdi>{amount}</bdi>}
        </dd>
        <dt className="break-words text-muted-foreground">{m.library_entry_reading_total({}, options)}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {progress.total === null ? m.library_entry_reading_total_unknown({}, options) : <bdi>{progress.total}</bdi>}
        </dd>
        {progress.mode === 'cursor_position' ? (
          <>
            <dt className="break-words text-muted-foreground">{m.library_progress_locator({}, options)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {progress.locator || m.library_entry_reading_value_unavailable({}, options)}
            </dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm text-muted-foreground">{meaning}</p>
    </section>
  );
}
