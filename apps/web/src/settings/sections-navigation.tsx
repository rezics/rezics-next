import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
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

/** Keep every section reachable before hydration and retain native section hash links. */
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
  const [hydrated, setHydrated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => setHydrated(true), []);
  useEffect(() => setExpanded(false), [selected]);
  const current = sections.find((section) => section.id === selected);
  return (
    <nav aria-label={m.settings_sections_label()} className="min-w-0 lg:sticky lg:top-6 lg:self-start">
      <p className={cn('mb-2 text-sm font-medium text-muted-foreground', hydrated && 'hidden lg:block')}>
        {m.settings_sections_label()}
      </p>
      {hydrated ? (
        <button
          ref={trigger}
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-start focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
        >
          <span className="text-sm text-muted-foreground">{m.settings_sections_label()}</span>
          <span className="ms-auto min-w-0 wrap-anywhere text-sm font-semibold">{current?.label}</span>
          <ChevronDown aria-hidden="true" size={16} className={cn('shrink-0', expanded && 'rotate-180')} />
        </button>
      ) : null}
      <ul
        id={listId}
        className={cn(
          'mt-1 grid-cols-2 gap-1 text-sm lg:block lg:space-y-1',
          hydrated && !expanded ? 'hidden' : 'grid',
        )}
      >
        {sections.map((section) => (
          <li key={section.id} className="min-w-0">
            <a
              href={`#${section.id}`}
              aria-current={selected === section.id ? 'location' : undefined}
              onClick={(event) => {
                onSelect?.(section.id, event);
                if (event.defaultPrevented && expanded && section.id === selected) {
                  setExpanded(false);
                  trigger.current?.focus();
                }
              }}
              className={cn(
                'flex min-h-10 min-w-0 flex-col justify-center gap-0.5 rounded-md border-s-2 border-transparent px-3 py-2 text-start text-muted-foreground wrap-anywhere hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                'aria-[current=location]:border-primary aria-[current=location]:bg-muted aria-[current=location]:font-semibold aria-[current=location]:text-foreground',
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
