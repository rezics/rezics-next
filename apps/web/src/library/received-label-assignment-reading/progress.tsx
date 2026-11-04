import { useId } from 'react';
import { m } from '../../paraglide/messages.js';
import { progressView, type ProgressLabelInput } from '../progress-label';

/** The existing progress formatter remains the authority for the supplied observation's display. */
export function ReceivedProgress({ progress, locale }: { progress: ProgressLabelInput | null; locale: string }) {
  const descriptionId = useId();
  if (!progress)
    return <p className="text-sm text-muted-foreground">{m.library_received_reading_progress_unavailable()}</p>;
  const view = progressView(progress, locale);
  const mode =
    progress.mode === 'scalar_amount'
      ? m.library_progress_mode_amount()
      : progress.mode === 'cursor_position'
        ? m.library_progress_mode_cursor()
        : m.library_progress_mode_units();
  const meaning =
    progress.mode === 'scalar_amount'
      ? m.library_received_reading_amount_meaning()
      : progress.mode === 'cursor_position'
        ? m.library_received_reading_cursor_meaning()
        : m.library_received_reading_units_meaning();
  const amount =
    progress.mode === 'completed_units'
      ? String(progress.completedUnitCount)
      : progress.mode === 'cursor_position'
        ? (progress.position ?? null)
        : progress.amount;
  return (
    <div className="min-w-0 space-y-3" data-received-progress="">
      <p className="font-medium break-words" aria-describedby={descriptionId}>
        {view?.text ?? m.library_received_reading_value_unavailable()}
      </p>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {m.library_received_reading_session_observation()}
      </p>
      <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="break-words text-muted-foreground">{m.library_progress_mode()}</dt>
        <dd className="min-w-0 break-words">{mode}</dd>
        <dt className="break-words text-muted-foreground">{m.library_progress_unit()}</dt>
        <dd className="min-w-0 break-words" lang={progress.unitLabelLanguage}>
          {progress.unitLabel || m.library_progress_unit_unspecified()}
        </dd>
        <dt className="break-words text-muted-foreground">
          {progress.mode === 'cursor_position'
            ? m.library_received_reading_position()
            : progress.mode === 'completed_units'
              ? m.library_received_reading_completed_units()
              : m.library_received_reading_amount()}
        </dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {amount === null ? m.library_received_reading_value_unavailable() : <bdi>{amount}</bdi>}
        </dd>
        <dt className="break-words text-muted-foreground">{m.library_received_reading_total()}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {progress.total === null ? m.library_received_reading_total_unknown() : <bdi>{progress.total}</bdi>}
        </dd>
        {progress.mode === 'cursor_position' ? (
          <>
            <dt className="break-words text-muted-foreground">{m.library_progress_locator()}</dt>
            <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {progress.locator || m.library_received_reading_value_unavailable()}
            </dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm text-muted-foreground">{meaning}</p>
    </div>
  );
}
