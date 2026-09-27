'use client';

import { NativeSelect } from '@rezics/ui/native-select';
import { useAccountClient } from '../api/account-client.tsx';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { uiLocales } from '../../i18n/locale.ts';

const names: Record<(typeof uiLocales)[number], string> = { en: 'English', 'zh-CN': '简体中文' };

/** Google-style language menu: `?hl=` re-renders the page in the chosen
 * language and remembers it, keeping any pending OAuth request intact. */
export function LocaleSelect() {
  const { t } = useTranslation('common');
  const locale = useLocale();
  const { navigate } = useAccountClient();
  return <NativeSelect aria-label={t.language} value={locale.current} size="md" className="min-w-36"
    onChange={event => {
      const url = new URL(window.location.href);
      url.searchParams.set('hl', event.currentTarget.value);
      navigate(url.toString());
    }}>
    {uiLocales.map(value => <option key={value} value={value} lang={value}>{names[value]}</option>)}
  </NativeSelect>;
}
