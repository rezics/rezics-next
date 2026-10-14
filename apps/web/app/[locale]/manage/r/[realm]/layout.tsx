import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../../../../i18n/define.ts';
import type { AgentOption } from '../../../../../features/auth/acting-identity.ts';
import { ACCESS_COOKIE } from '../../../../../features/auth/cookies.ts';
import { realmEditSite } from '../../../../../features/manage/realm-site.ts';
import { RealmFrame } from '../../../../../features/manage/realm-frame.tsx';
import { settle } from '../../../../../features/manage/read.ts';
import { managedAddress, manager, realmHeader } from '../../../../../features/manage/server.ts';
import type { MainClient } from '../../../../../features/manage/types.ts';
import { showcaseEditorOpen } from '../../../../../features/zone-editor/edit-link.tsx';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

/** The management frame after the manager has admitted the acting Person. */
export async function realmManagementFrame({ main, realm, address, actingSubject, agent, locale, token, accessClient,
  children }: {
  main: MainClient; realm: string; address: string; actingSubject: string; agent: AgentOption; locale: UiLocale;
  token?: string;
  /** The section tabs' client. Production omits it and the tabs use the browser host client. */
  accessClient?: MainClient; children: ReactNode;
}) {
  const [messages, header, siteHref] = await Promise.all([
    getMessages('manage', locale),
    realmHeader(main, realm, locale, actingSubject),
    realmEditSite({
      zone: () => settle(() => main.v1.realms({ realm }).zone.get({ query: { actingSubject } })),
      editor: zoneId => showcaseEditorOpen(zoneId, actingSubject, token),
    }),
  ]);
  return <RealmFrame realm={realm} address={address} header={header.ok ? header.data : null} agent={agent}
    locale={locale} messages={messages} siteHref={siteHref} accessClient={accessClient}>{children}</RealmFrame>;
}

export default async function RealmManagementLayout({ children, params }: {
  children: ReactNode; params: Promise<{ realm: string }>;
}) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const { agent, actingSubject, main } = await manager(locale, `/manage/r/${target.address}`);
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return realmManagementFrame({ main, realm: target.id, address: target.address, actingSubject, agent, locale, token, children });
}
