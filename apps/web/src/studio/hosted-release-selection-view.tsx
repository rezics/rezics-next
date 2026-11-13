import { Button } from '@rezics/ui/shadcn/button';
import type { Locale } from '../paraglide/runtime.js';
import type { HostedReleasePreparationVisit, ReleaseState } from './hosted-release-preparation';
import { releaseSelectionCopy } from './hosted-release-selection-copy';

const control = 'min-h-11 max-w-full whitespace-normal text-start';
const valueStyle = 'min-w-0 break-all font-mono text-sm';

export function HostedReleaseSelectionView({
  visit,
  state,
  locale,
}: {
  visit: HostedReleasePreparationVisit;
  state: Extract<ReleaseState, { kind: 'active' }>;
  locale: Locale;
}) {
  const copy = releaseSelectionCopy[locale];
  const { progress, selection, pending } = state;
  if (state.mode !== 'selection' || !progress) return null;
  const editable = state.phase === 'selecting' && !state.busy;
  const choices = selection?.occurrenceIds ?? [];
  const outline = selection?.outline;
  const format = (count: string | number) => new Intl.NumberFormat(locale).format(BigInt(count));
  const open = progress.stage.state === 'collecting';
  return (
    <section className="min-w-0 space-y-4" aria-label={copy.heading} aria-busy={state.busy}>
      <h2>{copy.heading}</h2>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt>{copy.inputCount}</dt>
        <dd className="break-all tabular-nums">{format(progress.stage.inputCount)}</dd>
        <dt>{copy.inputVersion}</dt>
        <dd className="break-all tabular-nums">{format(progress.stage.inputVersion)}</dd>
        <dt>{copy.inputState}</dt>
        <dd>{open ? copy.collecting : copy.frozen}</dd>
      </dl>
      <p className="max-w-prose">{copy.choices}</p>
      <p className="max-w-prose">{copy.duplicates}</p>
      {pending?.kind === 'append' ? (
        <div className="space-y-2 rounded-lg border p-4">
          <p>{copy.pending}</p>
          <dl>
            <dt>{copy.batch}</dt>
            <dd className={valueStyle}>{pending.body.batchId}</dd>
            <dt>{copy.unsent}</dt>
            <dd>{format(pending.body.occurrenceIds.length)}</dd>
          </dl>
        </div>
      ) : null}
      {open && !state.review ? <p className="max-w-prose">{copy.resumed}</p> : null}
      {outline ? (
        <section className="min-w-0 space-y-3" aria-label={copy.page} aria-busy={outline.kind === 'loading'}>
          <h3>{copy.page}</h3>
          <p className="max-w-prose">{copy.help}</p>
          {outline.kind === 'loading' ? <p role="status">{copy.loading}</p> : null}
          {outline.kind === 'failed' ? (
            <div className="space-y-3">
              <p role="alert">{copy.pageFailed}</p>
              <Button
                className={control}
                variant="outline"
                disabled={!editable}
                onClick={() => void visit.loadSelectionPage('retry')}
              >
                {copy.retryPage}
              </Button>
            </div>
          ) : null}
          {outline.kind === 'ready' ? (
            <>
              <ul className="min-w-0 divide-y rounded-lg border px-3">
                {outline.page.items.map((item) => (
                  <li key={item.occurrenceId} className="min-w-0 py-2">
                    <label className="flex min-h-11 min-w-0 items-start gap-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1 size-5 shrink-0"
                        checked={choices.includes(item.occurrenceId)}
                        disabled={!editable || item.availability !== 'available'}
                        onChange={() => visit.choosePlacement(item.occurrenceId)}
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="block break-words font-medium">
                          {item.availability === 'available' ? item.title : copy.unavailable}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {item.kind === 'part' ? copy.part : copy.chapter}
                        </span>
                        <span className={`block ${valueStyle}`}>{item.occurrenceId}</span>
                        <span className="block break-all text-sm text-muted-foreground">
                          {item.parentId ? `${copy.parent}: ${item.parentId}` : copy.root}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="tabular-nums">
                {copy.unsent}: {format(choices.length)}
              </p>
              <div className="flex flex-wrap items-start gap-3">
                <Button
                  className={control}
                  disabled={!editable || !choices.length}
                  onClick={() => void visit.appendSelection()}
                >
                  {copy.add}
                </Button>
                {outline.page.nextCursor !== null ? (
                  <Button
                    className={control}
                    variant="outline"
                    disabled={!editable || choices.length > 0}
                    onClick={() => void visit.loadSelectionPage('next')}
                  >
                    {copy.next}
                  </Button>
                ) : null}
                {outline.cursor !== null ? (
                  <Button
                    className={control}
                    variant="outline"
                    disabled={!editable || choices.length > 0}
                    onClick={() => void visit.loadSelectionPage('first')}
                  >
                    {copy.first}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      {open ? (
        <div className="space-y-3">
          <p className="max-w-prose">{progress.stage.inputCount === '0' ? copy.empty : copy.freezeHelp}</p>
          <Button
            className={control}
            disabled={!editable || progress.stage.inputCount === '0' || choices.length > 0}
            onClick={() => void visit.freezeSelection()}
          >
            {copy.freeze}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
