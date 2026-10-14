import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { loadZoneManagementFrame } from '../../../../../features/zone-editor/read.ts';
import { zoneEditorPath } from '../../../../../features/zone-editor/routes.ts';
import { zoneManagementShell } from '../../../../../features/zones/independent-zone-recorded-page-routes.tsx';
import { manager } from '../../../../../features/manage/server.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

export { zoneManagementShell };

export const metadata: Metadata = { robots: { index: false } };

export default async function ZoneEditorLayout({ children, params }: {
  children: ReactNode; params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  const locale = await requestLocale();
  const { agent, actingSubject, main } = await manager(locale, zoneEditorPath(space));
  const [manageMessages, loaded] = await Promise.all([
    getMessages('manage', locale),
    loadZoneManagementFrame(main, space, locale, actingSubject),
  ]);
  return zoneManagementShell({
    space, frame: loaded, agent, actingSubject, locale, manageMessages, children,
  });
}
