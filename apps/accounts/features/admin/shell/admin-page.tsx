import type { ReactNode } from 'react';
import { readSession } from '../../api/server.ts';
import { readAdminMe, readPreferences } from '../api/server.ts';
import type { AdminMe, Preferences } from '../api/types.ts';
import { AdminShell, type AdminSection } from './admin-shell.tsx';
import { AdminGate, NoPermission } from './admin-states.tsx';
import { TranslationProvider } from '../../../i18n/client.ts';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';

export interface AdminPageContext { me: AdminMe; preferences: Preferences; locale: string }
const defaults: Preferences = { density: 'comfortable', columns: null, views: [] };

/** Every panel page: the operator's role gates it (and each section's
 * permission); the shell carries their density; the admin catalog is seeded. */
export async function renderAdminPage(section: AdminSection | undefined, next: string,
  render: (context: AdminPageContext) => Promise<ReactNode> | ReactNode,
  permission?: AdminMe['permissions'][number]): Promise<ReactNode> {
  const locale = await requestLocale();
  const { snapshot } = await getTranslation('admin', [locale]);
  const translated = (node: ReactNode) => <TranslationProvider initial={snapshot} tags={[locale]}>{node}</TranslationProvider>;
  const session = await readSession();
  if (session.status !== 'ok') {
    return translated(<AdminGate status={session.status === 'signed-out' || session.status === 'stale' ? 'signed-out' : 'unavailable'}
      next={next} />);
  }
  const me = await readAdminMe();
  if (me.status !== 'ok') {
    return translated(<AdminGate status={me.status === 'signed-out' ? 'signed-out' : me.status === 'forbidden' ? 'forbidden' : 'unavailable'}
      next={next} />);
  }
  if (!me.data.role) return translated(<AdminGate status="forbidden" next={next} />);
  const preferences = await readPreferences();
  const context = { me: me.data, preferences: preferences.status === 'ok' ? preferences.data : defaults, locale };
  return translated(<AdminShell me={me.data} user={session.data.user} density={context.preferences.density} section={section}>
    {permission && !me.data.permissions.includes(permission) ? <NoPermission /> : await render(context)}
  </AdminShell>);
}
