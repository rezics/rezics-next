import { materializeData } from 'native-i18n';
import { defineMessages, type UiLocale } from '../../i18n/define.ts';
import type { ReadFailure } from './types.ts';
import type { WorkPageMessages } from './messages.ts';
import { editionCatalog } from './messages/editions.ts';
import { Region, RegionFailure } from './region.tsx';
import { ReleaseCard, type EditionMessages, type ShownRelease } from './release.tsx';

export const editionMessages = defineMessages(editionCatalog);

export type { EditionMessages };

export function EditionsSection({ items, failure, locale, messages }: {
  items: ShownRelease[] | null; failure: ReadFailure | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(editionMessages[locale], { locale });
  if (failure) return <RegionFailure title={t.editions} failure={failure} messages={messages} />;
  if (!items?.length) return null;
  return <Region id="work-editions" title={t.editions}>
    <div className="grid gap-5">{items.map(release => <ReleaseCard key={release.id} release={release} locale={locale}
      messages={t} />)}</div>
  </Region>;
}
