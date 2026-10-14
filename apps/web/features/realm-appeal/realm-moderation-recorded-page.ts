import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { realmQueueBody } from '../../app/[locale]/manage/r/[realm]/page.tsx';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { QueueView } from '../manage/routes.ts';
import { recordedManagementAgent } from '../realm/realm-membership-recorded-page.ts';

/**
 * The moderation queue inside its management frame. Both call the production
 * readers. The sanction panel receives the same client, so its basis and
 * receipt reads are the ones the open item issues. Production omits that
 * client and the panel uses the browser host client.
 */
export async function recordedModerationRoute(main: MainClient, fetcher: typeof fetch, realm: string, locale: UiLocale,
  view: QueueView): Promise<ReactNode> {
  const { agent, actingSubject } = await recordedManagementAgent(fetcher, locale);
  const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher });
  const body = await realmQueueBody({
    main, anonymous, principal: actingSubject, realm, address: realm, actingSubject, view, locale,
    signInHref: '/auth/start', appealClient: main,
  });
  return realmManagementFrame({
    main, realm, address: realm, actingSubject, agent, locale, children: body, accessClient: main,
  });
}
