import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { ScopedRatingMessages } from './messages.ts';

/** The strings of this feature in the reader's language, as every component materializes its `messages` prop. */
export type Translation = ReturnType<typeof materializeData<ScopedRatingMessages>>;
export const translate = (messages: ScopedRatingMessages, locale: UiLocale): Translation =>
  materializeData(messages, { locale });

export const formatNumber = (value: number, locale: UiLocale, digits = 0) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export const formatShare = (part: number, whole: number, locale: UiLocale) =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(whole ? part / whole : 0);

/** A mean to two decimals, as the Work page sets every average ("8.44"), so one number never reads two ways. */
export const formatMean = (value: number, locale: UiLocale) => formatNumber(value, locale, 2);
