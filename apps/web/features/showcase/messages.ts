import { defineMessages } from '../../i18n/define.ts';

/** Strings of showcase surfaces that live outside a Zone, such as the Work page header. */
export const messages = defineMessages({
  en: { watchTrailer: 'Watch trailer' },
  'zh-Hant': { watchTrailer: '觀看預告片' },
  'zh-Hans': { watchTrailer: '观看预告片' },
  ja: { watchTrailer: '予告編を見る' },
  ko: { watchTrailer: '예고편 보기' },
  de: { watchTrailer: 'Trailer ansehen' },
  fr: { watchTrailer: 'Voir la bande-annonce' },
  es: { watchTrailer: 'Ver tráiler' },
});

export type ShowcaseMessages = (typeof messages)['en'];
