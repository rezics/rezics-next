import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { ProgressRecordInput } from './progress-reads';

/** Show the captured request, including exact sparse keys, before sending or retrying it. */
export function ProgressCorrectionReview({
  data,
  busy,
  conflict,
  onConfirm,
  onCancel,
  onReload,
}: {
  data: ProgressRecordInput;
  busy: boolean;
  conflict: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  return (
    <section className="space-y-4" aria-label={m.library_progress_review()}>
      <h2 className="text-xl font-semibold">{m.library_progress_review()}</h2>
      {data.clear ? (
        <p>{m.library_progress_clear_scope()}</p>
      ) : (
        <dl className="space-y-3">
          {data.amount !== undefined ? (
            <div>
              <dt>{m.library_progress_amount()}</dt>
              <dd className="break-all">{data.amount}</dd>
            </div>
          ) : null}
          {data.locator !== undefined ? (
            <div>
              <dt>{m.library_progress_locator()}</dt>
              <dd className="whitespace-pre-wrap break-all">{data.locator}</dd>
            </div>
          ) : null}
          {data.position !== undefined ? (
            <div>
              <dt>{m.library_progress_position()}</dt>
              <dd>{data.position}</dd>
            </div>
          ) : null}
          {(
            [
              ['add', m.library_progress_add_units()],
              ['remove', m.library_progress_remove_units()],
            ] as const
          ).map(([field, label]) =>
            data[field] ? (
              <div key={field}>
                <dt>{label}</dt>
                <dd>
                  <ul>
                    {data[field].map((id) => (
                      <li key={id} className="break-all">
                        {id}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={onConfirm}>
          {data.clear ? m.library_progress_confirm_clear() : m.library_progress_confirm_correction()}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {m.library_progress_cancel()}
        </Button>
        {conflict ? (
          <Button variant="outline" disabled={busy} onClick={onReload}>
            {m.library_progress_review_latest()}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
