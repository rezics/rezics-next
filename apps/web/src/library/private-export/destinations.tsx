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

/** Signed-in Library portability visits. Each recovery still requires a deliberate upload or original-archive reuse. */
export function ArchiveRecoveryDestinations({ current }: { current?: ArchiveRecoveryDestination }) {
  return (
    <nav aria-label={m.library_archive_destinations()} className="flex flex-wrap gap-3">
      {items
        .filter((item) => item.id !== current)
        .map((item) => (
          <a
            key={item.href}
            className={`${actionClass} inline-flex items-center underline`}
            href={localizeHref(item.href)}
          >
            {item.label()}
          </a>
        ))}
    </nav>
  );
}
