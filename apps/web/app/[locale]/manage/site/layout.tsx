import type { ReactNode } from 'react';
import { SiteFrame } from '../../../../features/manage/site-frame.tsx';
import { manager } from '../../../../features/manage/server.ts';
import { SITE_SAFETY_PATH } from '../../../../features/manage/safety-state.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

export default async function SiteManagementLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  const { agent } = await manager(locale, SITE_SAFETY_PATH);
  const messages = await getMessages('manage', locale);
  return <SiteFrame agent={agent} locale={locale} messages={messages}>{children}</SiteFrame>;
}
