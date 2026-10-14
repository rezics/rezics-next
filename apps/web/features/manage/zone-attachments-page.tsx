import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { ManageMessages } from './messages.ts';
import { ManageFailure } from './parts.tsx';
import type { readZoneAttachments } from './read.ts';
import type { MainClient } from './types.ts';
import { ZoneAttachments } from './zone-attachments.tsx';

export type ZoneAttachmentsRead = Awaited<ReturnType<typeof readZoneAttachments>>;

/** Server render and stories consume the same reader result and localize attachment times in UTC. */
export function ZoneAttachmentsPage({ principal, page, realm, actingSubject, locale, messages, signInHref, retryHref, client }: {
  principal: string;
  page: ZoneAttachmentsRead | null; realm: string; actingSubject: string; locale: UiLocale; messages: ManageMessages;
  signInHref?: string; retryHref?: string; client?: () => MainClient;
}) {
  if (page === null) return <p role="status" aria-busy="true">{materializeData(messages, { locale }).loadingMore}</p>;
  if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={retryHref} />;
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return <ZoneAttachments principal={principal} realm={realm} actingSubject={actingSubject} locale={locale} messages={messages}
    client={client} nextCursor={page.data.nextCursor} items={page.data.items.map(item => ({ ...item,
      when: item.attachedAt ? formatter.format(new Date(item.attachedAt)) : null }))} />;
}
