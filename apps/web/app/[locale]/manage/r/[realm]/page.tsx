import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { UiLocale } from '../../../../../i18n/define.ts';
import { ManageFailure } from '../../../../../features/manage/parts.tsx';
import { readQueueNames } from '../../../../../features/manage/queue-api.ts';
import { authorityFrom } from '../../../../../features/manage/queue-state.ts';
import { QueueView } from '../../../../../features/manage/queue-view.tsx';
import { appealDecisionAuthority } from '../../../../../features/realm-appeal/decision-api.ts';
import { readQueue } from '../../../../../features/manage/read.ts';
import { parseQueueView, queueHref, realmHref, type QueueView as QueueQuery } from '../../../../../features/manage/routes.ts';
import { managedAddress, manager, permissionsIn, realmHeader } from '../../../../../features/manage/server.ts';
import type { MainClient } from '../../../../../features/manage/types.ts';
import { localizedPath } from '../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabQueue, robots: { index: false } };
}

export default async function RealmQueueRoute({ params, searchParams }: {
  params: Promise<{ realm: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [path, query] = await Promise.all([params, searchParams]);
  const target = await managedAddress(path.realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const view = parseQueueView(query);
  const { principal, actingSubject, main, anonymous, signInHref } = await manager(locale, queueHref(address, view));
  return realmQueueBody({ main, anonymous, principal, realm, address, actingSubject, view, locale, signInHref });
}

/** The queue after its manager admits the acting Person. Stories pass the replaying client. */
export async function realmQueueBody({ main, anonymous, principal, realm, address = realm, actingSubject, view,
  locale, signInHref, appealClient, now }: {
  main: MainClient; anonymous: MainClient; principal: string; realm: string; address?: string; actingSubject: string;
  view: QueueQuery; locale: UiLocale; signInHref: string;
  /** The sanction panel's client. Production omits it and the panel uses the browser host client. */
  appealClient?: MainClient; now?: number;
}) {
  const [messages, page, permissions, header] = await Promise.all([getMessages('manage', locale),
    readQueue(main, realm, { actingSubject, ...view }), permissionsIn(main, actingSubject, realm),
    realmHeader(main, realm, locale, actingSubject)]);
  if (!page.ok) {
    return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
      retryHref={localizedPath(queueHref(address, view), locale)} />;
  }
  // A role can authorize moderation without allowing a private Realm header read.
  const names = await readQueueNames(main, realm, page.data.items, { language: locale, actingSubject }, undefined,
    anonymous);
  // Rules are published from Settings, which needs both permissions Main checks there.
  const publishesRules = permissions === null || permissions.includes('governance.rule.publish')
    && permissions.includes('realm.settings.manage');
  // An authorized report read also proves report access when the optional permission read is unavailable.
  const readsReports = permissions === null ? page.data.items.some(item => item.kind === 'content_report' || item.kind === 'rights_complaint')
    : permissions.includes('governance.moderate');
  return <QueueView principal={principal} recoverReports={readsReports} key={`${principal}:${realm}:${actingSubject}:${readsReports}:${view.state}:${view.type ?? ''}:${view.reason ?? ''}`} realm={realm} address={address}
    actingSubject={actingSubject} view={view} initial={page.data} names={names}
    realmRules={header.ok ? header.data.rules ?? undefined : undefined} authority={authorityFrom(permissions)}
    appealAuthority={appealDecisionAuthority(permissions)}
    rulesHref={publishesRules ? realmHref(address, 'settings') : null} now={now ?? Date.now()} locale={locale}
    messages={messages} {...appealClient ? { appealClient } : {}} />;
}
