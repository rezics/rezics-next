import { m } from '../paraglide/messages.js';
import type { MouseEvent } from 'react';

export type SettingsSection = {
  id:
    | 'watches'
    | 'reading'
    | 'display'
    | 'notifications'
    | 'privacy'
    | 'verification'
    | 'profile'
    | 'public-activity'
    | 'account';
  label: string;
  status?: string | undefined;
};

export function settingsSections({
  display,
  notifications,
  collections,
  verification,
  readingState,
}: {
  display?: boolean;
  notifications: boolean;
  collections: boolean;
  verification: boolean;
  readingState?: 'closed' | 'preparing' | 'unavailable' | undefined;
}): SettingsSection[] {
  return [
    {
      id: 'reading',
      label: m.settings_reading_heading(),
      status:
        readingState === 'closed'
          ? m.settings_closed_title()
          : readingState === 'preparing'
            ? m.settings_preparing_title()
            : readingState === 'unavailable'
              ? m.settings_unavailable_title()
              : undefined,
    },
    ...(display ? [{ id: 'display' as const, label: m.settings_display_heading() }] : []),
    { id: 'watches', label: m.settings_watches_heading() },
    ...(notifications ? [{ id: 'notifications' as const, label: m.settings_notifications_heading() }] : []),
    ...(collections ? [{ id: 'privacy' as const, label: m.settings_privacy_heading() }] : []),
    ...(verification ? [{ id: 'verification' as const, label: m.settings_verification_heading() }] : []),
    { id: 'profile', label: m.settings_profile_heading() },
    { id: 'public-activity', label: m.settings_public_activity_heading() },
    { id: 'account', label: m.settings_account_heading() },
  ];
}

/** A bounded anchor grid uses the existing section hashes for focused destinations. */
export function SectionsNavigation({
  sections,
  pending = false,
  selected = 'reading',
  onSelect,
}: {
  sections: readonly SettingsSection[];
  pending?: boolean;
  selected?: SettingsSection['id'];
  onSelect?: (id: SettingsSection['id'], event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <nav aria-label={m.settings_sections_label()} className="min-w-0 lg:sticky lg:top-6 lg:self-start">
      <p className="mb-3 font-medium lg:sr-only">{m.settings_sections_label()}</p>
      <ul className="grid grid-cols-2 gap-2 text-sm lg:block lg:space-y-2 lg:border-l lg:border-border lg:pl-4">
        {sections.map((section) => (
          <li key={section.id} className="min-w-0">
            <a
              href={`#${section.id}`}
              aria-current={selected === section.id ? 'location' : undefined}
              onClick={(event) => onSelect?.(section.id, event)}
              className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-md border border-border px-3 py-2 break-words text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=location]:border-primary aria-[current=location]:bg-muted aria-[current=location]:font-semibold aria-[current=location]:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span>{section.label}</span>
              {section.status ? <span className="text-xs">{section.status}</span> : null}
            </a>
          </li>
        ))}
      </ul>
      {pending ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {m.settings_sections_loading()}
        </p>
      ) : null}
    </nav>
  );
}
