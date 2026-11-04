import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { subjectOf } from '../reads';
import { SubjectIdentity, rowRatio } from '../subject-row';
import { VndbAction, vndbActionClass } from '../personal-list-import/controls';
import type { ImportLibraryRead } from './read';

/** These are current native Library rows; upload scores and progress never decorate this list. */
export function ImportLibraryView({
  result,
  busy,
  available = true,
  onRead,
}: {
  result: ImportLibraryRead | null;
  busy: boolean;
  available?: boolean;
  onRead: () => void;
}) {
  const entries = result?.state === 'current' ? result.page.libraryEntries : [];
  const subjects = entries.map((entry) => subjectOf(entry.subject));
  const ratio = rowRatio(subjects);
  return (
    <section className="min-w-0 space-y-4 rounded-lg border p-4" data-vndb-library-return>
      <h2 className="text-xl font-semibold">{m.library_vndb_library_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.library_vndb_library_help()}</p>
      <div className="flex flex-wrap gap-3">
        <VndbAction type="button" variant="outline" disabled={busy || !available} aria-busy={busy} onClick={onRead}>
          {busy ? m.library_vndb_library_loading() : m.library_vndb_library_refresh()}
        </VndbAction>
        <Link to="/library" className={vndbActionClass + ' inline-flex items-center rounded-md border'}>
          {m.library_vndb_library_open()}
        </Link>
      </div>
      {result && result.state !== 'current' ? (
        <p role="status">
          {result.state === 'denied'
            ? m.library_bangumi_denied()
            : result.state === 'closed'
              ? m.platform_closed_message()
              : m.library_bangumi_unavailable()}
        </p>
      ) : null}
      {result?.state === 'current' ? (
        <>
          <p role="status">{m.library_vndb_library_count({ count: entries.length })}</p>
          <ul className="divide-y">
            {entries.map((entry, index) => (
              <li
                key={entry.subjectId}
                className="min-w-0 py-3 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center"
                data-vndb-current-entry={entry.subjectId}
              >
                <SubjectIdentity subject={subjects[index] ?? null} ratio={ratio}>
                  <span>{m.library_vndb_library_state({ state: entry.state })}</span>
                </SubjectIdentity>
              </li>
            ))}
          </ul>
          {result.page.next ? <p className="text-sm">{m.library_vndb_library_more()}</p> : null}
        </>
      ) : null}
    </section>
  );
}
