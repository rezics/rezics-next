'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { AboutDiscussion } from './about-discussion.tsx';
import type { AboutDiscussionRead } from './about-discussion-api.ts';

/** Discussion region for a mapped Zone read. A read that has not arrived stays on the shell loading status. */
export function ZoneDiscussionRecordedPage({
  read,
  locale,
  href,
}: {
  read: AboutDiscussionRead | null;
  locale: UiLocale;
  href: string;
}) {
  if (!read)
    return (
      <p role="status" aria-busy="true">
        {locale === 'ja' ? shellJa.loading : shellMessages.loading}
      </p>
    );
  return <AboutDiscussion read={read} locale={locale} href={href} retain={false} />;
}
