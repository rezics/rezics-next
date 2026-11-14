import { useId } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { actionClass } from './controls';

export type ArchiveRecoveryDestination = 'export' | 'collections' | 'entries' | 'progress';

const items: readonly { id: ArchiveRecoveryDestination; href: string; label: () => string }[] = [
  { id: 'export', href: '/library/export', label: () => m.library_export_title() },
  { id: 'collections', href: '/library/recover-collections', label: () => m.library_archive_recovery_nav() },
  { id: 'entries', href: '/library/recover-archive', label: () => m.library_archive_title() },
  { id: 'progress', href: '/library/recover-progress', label: () => m.library_archive_progress_title() },
];

/** Each recovery owns its upload/reuse, review and confirmation. Export itself restores nothing. */
export function ArchiveRecoveryDestinations({ current }: { current?: ArchiveRecoveryDestination }) {
  const headingId = useId();
  if (current === 'export') {
    const destinations = [
      {
        id: 'collections',
        href: '/library/recover-collections',
        label: m.library_export_restore_collections(),
        description: m.library_export_restore_collections_help(),
      },
      {
        id: 'entries',
        href: '/library/recover-archive',
        label: m.library_export_restore_entries(),
        description: m.library_export_restore_entries_help(),
      },
      {
        id: 'progress',
        href: '/library/recover-progress',
        label: m.library_export_restore_progress(),
        description: m.library_export_restore_progress_help(),
      },
    ] as const;
    return (
      <section aria-labelledby={headingId} className="space-y-4 border-t pt-6">
        <h2 id={headingId} className="text-lg font-semibold">{m.library_export_restore_heading()}</h2>
        <p className="text-sm text-muted-foreground">{m.library_export_restore_help()}</p>
        <nav aria-label={m.library_archive_destinations()}>
          <ul className="divide-y">
            {destinations.map((item) => (
              <li key={item.href} className="space-y-1 py-3 first:pt-0">
                <Link
                  className={`${actionClass} -ml-3 inline-flex items-center font-medium underline underline-offset-4`}
                  to={item.href}
                  search={{}}
                  preload={false}
                  aria-describedby={`${headingId}-${item.id}`}
                >
                  {item.label}
                </Link>
                <p id={`${headingId}-${item.id}`} className="text-sm text-muted-foreground">
                  {item.description}
                </p>
              </li>
            ))}
          </ul>
        </nav>
      </section>
    );
  }
  return (
    <nav aria-label={m.library_archive_destinations()} className="flex flex-wrap gap-3">
      {items.filter((item) => item.id !== current).map((item) => (
        <a key={item.href} className={`${actionClass} inline-flex items-center underline`} href={localizeHref(item.href)}>
          {item.label()}
        </a>
      ))}
    </nav>
  );
}
