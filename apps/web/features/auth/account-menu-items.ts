import type { AuthMessages } from './messages.ts';
import type { Session } from './session.ts';

export type AccountMenuEntry =
  | { id: string; label: string; href: string; arrow?: boolean }
  | { id: 'language' | 'appearance'; label: string; panel: true };

/** One order and one set of destinations for the desktop menu and phone sheet. */
export function accountMenuSections(session: Session, t: AuthMessages): AccountMenuEntry[][] {
  const handle = session.agent.status === 'selected' ? session.agent.agent.handle : null;
  return [
    [
      { id: 'profile', label: t.profile, href: handle ? `/@${handle}` : '/settings#profile' },
      { id: 'library', label: t.library, href: '/library' },
      { id: 'studio', label: t.studio, href: '/studio' },
      { id: 'notifications', label: t.notifications, href: '/notifications' },
    ],
    [
      { id: 'language', label: t.language, panel: true },
      { id: 'appearance', label: t.appearance, panel: true },
      {
        id: 'content-preferences',
        label: t.contentPreferences,
        href: '/settings#reading',
        arrow: true,
      },
    ],
    [{ id: 'settings', label: t.settings, href: '/settings' }],
  ];
}
