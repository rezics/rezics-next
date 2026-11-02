import { m } from '../paraglide/messages.js';
import type { LabelsAddressIssue } from './labels-address';

export function LabelsAddressRecovery({
  issue,
  query,
  rawQuery,
  rawCursor,
}: {
  issue: LabelsAddressIssue;
  query: string | null;
  rawQuery: string | null;
  rawCursor: string | null;
}) {
  const prefixIssue = issue === 'prefix';

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{m.library_labels_heading()}</h1>
      <section className="space-y-3" aria-labelledby="labels-address-title">
        <h2 id="labels-address-title" className="text-lg font-medium">
          {prefixIssue ? m.library_labels_address_prefix_title() : m.library_labels_address_cursor_title()}
        </h2>
        <p role="alert">
          {prefixIssue
            ? m.library_labels_address_prefix_description()
            : m.library_labels_address_cursor_description()}
        </p>
        <form method="get" className="space-y-3">
          {prefixIssue ? (
            <label className="grid gap-1">
              <span>{m.library_labels_address_prefix_label()}</span>
              <input name="q" type="text" defaultValue={rawQuery ?? ''} className="min-h-11 rounded border px-3" />
            </label>
          ) : (
            <>
              {query !== null ? <input type="hidden" name="q" value={query} /> : null}
              <label className="grid gap-1">
                <span>{m.library_labels_address_cursor_label()}</span>
                <input
                  name="cursor"
                  type="text"
                  defaultValue={rawCursor ?? ''}
                  className="min-h-11 rounded border px-3"
                />
              </label>
            </>
          )}
          <button type="submit" className="min-h-11 rounded bg-primary px-4 text-primary-foreground">
            {m.library_labels_address_continue()}
          </button>
        </form>
        <form method="get">
          <button type="submit" className="min-h-11 rounded border px-4">
            {m.library_labels_address_clear()}
          </button>
        </form>
      </section>
    </main>
  );
}
