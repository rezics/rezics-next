import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';

const actionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md px-3 py-2 underline whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** No private input is accepted before the complete native review contract is available. */
export function ArchiveEntryRecoveryPage() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <header className="space-y-3">
        <PageHeading>{m.library_archive_title()}</PageHeading>
        <p className="text-muted-foreground">{m.library_archive_intro()}</p>
      </header>

      <ol aria-label={m.library_archive_steps()} className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <li aria-current="step" className="font-semibold">
          1. {m.library_archive_upload_step()}
        </li>
        <li>2. {m.library_archive_review_step()}</li>
        <li>3. {m.library_archive_results_step()}</li>
      </ol>

      <section aria-labelledby="archive-availability" className="space-y-3 rounded-lg border p-4">
        <h2 id="archive-availability" className="text-xl font-semibold">
          {m.library_archive_unavailable_title()}
        </h2>
        <p role="status">{m.library_archive_unavailable()}</p>
        <p id="archive-file-help" className="text-sm text-muted-foreground">
          {m.library_archive_keep_file()}
        </p>
        <label htmlFor="archive-file" className="block font-medium">
          {m.library_archive_choose_file()}
        </label>
        <input
          id="archive-file"
          type="file"
          accept="application/json,.json"
          disabled
          aria-describedby="archive-file-help"
          className="block min-h-11 w-full max-w-full rounded-md border p-2 disabled:opacity-60"
        />
      </section>

      <section aria-labelledby="archive-scope" className="space-y-4">
        <h2 id="archive-scope" className="text-xl font-semibold">
          {m.library_archive_scope_title()}
        </h2>
        <p>{m.library_archive_scope_intro()}</p>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border p-4">
            <dt className="font-semibold">{m.library_archive_supported_title()}</dt>
            <dd>{m.library_archive_supported()}</dd>
          </div>
          <div className="space-y-2 rounded-lg border p-4">
            <dt className="font-semibold">{m.library_archive_outside_title()}</dt>
            <dd>{m.library_archive_outside()}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">{m.library_archive_inventory()}</p>
      </section>

      <section aria-labelledby="archive-review" className="space-y-3">
        <h2 id="archive-review" className="text-xl font-semibold">
          {m.library_archive_deliberate_title()}
        </h2>
        <p>{m.library_archive_deliberate()}</p>
        <p>{m.library_archive_history()}</p>
      </section>

      <nav aria-label={m.library_archive_destinations()} className="flex flex-wrap gap-3">
        <a href={localizeHref('/library')} className={actionClass}>
          {m.library_archive_return()}
        </a>
        <a href={localizeHref('/library/export')} className={actionClass}>
          {m.library_archive_export()}
        </a>
      </nav>
    </main>
  );
}
