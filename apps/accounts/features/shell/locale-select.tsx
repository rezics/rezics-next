'use client';

import { ChoiceSelect } from '@rezics/ui/select';
import { useAccountClient } from '../api/account-client.tsx';
import { useLocale, useTranslation } from '../../i18n/client.ts';
import { localeNames, uiLocales } from '../../i18n/locale.ts';

/** Google-style language menu: `?hl=` re-renders the page in the chosen
 * language and remembers it, keeping any pending OAuth request intact. */
export function LocaleSelect() {
  const { t } = useTranslation('common');
  const locale = useLocale();
  const { navigate } = useAccountClient();
  return <ChoiceSelect label={t.language} value={locale.current} size="md" className="min-w-36"
    options={uiLocales.map(value => ({ value, label: localeNames[value], lang: value }))}
    onValueChange={value => {
      const url = new URL(window.location.href);
      url.searchParams.set('hl', value);
      navigate(url.toString());
    }} />;
}
