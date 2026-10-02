import { Alert, AlertDescription } from '@rezics/ui/alert';
import type { UiLocale } from '../../i18n/define.ts';
import type { Discovery } from '../manage/settings-api.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { SpaceDiscovery } from './discovery.tsx';

export function UnlistedSpaceNotice({ locale, discovery }: { locale: UiLocale; discovery: Discovery }) {
  return <><SpaceDiscovery discovery={discovery} /><Alert><AlertDescription>{accessMessages[locale].unlistedNotice}</AlertDescription></Alert></>;
}
