import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import type { MouseEvent } from 'react';
import type { SettingsOperationAdmission } from './ports/shell';

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
  admission = 'unknown',
  selected = 'reading',
  onSelect,
}: {
  sections: readonly SettingsSection[];
  admission?: SettingsOperationAdmission;
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
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'h-auto min-h-6 w-full min-w-0 flex-col items-start justify-center gap-1 whitespace-normal break-words text-start font-normal text-muted-foreground',
                'aria-[current=location]:border-primary aria-[current=location]:bg-muted aria-[current=location]:font-semibold aria-[current=location]:text-primary',
              )}
            >
              <span>{section.label}</span>
              {section.status ? <span className="text-xs">{section.status}</span> : null}
            </a>
          </li>
        ))}
      </ul>
      {admission !== 'available' ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {admission === 'unknown'
            ? m.settings_sections_loading()
            : admission === 'denied'
              ? m.settings_closed_title()
              : m.settings_unavailable_title()}
        </p>
      ) : null}
    </nav>
  );
}
