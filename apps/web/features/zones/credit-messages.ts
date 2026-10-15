import type { UiLocale } from '../../i18n/define.ts';

export const creditText = {
  en: { original: 'Original contribution', contributor: 'View contributor' },
  ja: { original: 'オリジナルの投稿', contributor: '投稿者を見る' },
  'zh-Hans': { original: '原创投稿', contributor: '查看投稿者' },
  'zh-Hant': { original: '原創投稿', contributor: '查看投稿者' },
  ko: { original: '원본 기여', contributor: '기여자 보기' },
  de: { original: 'Originalbeitrag', contributor: 'Mitwirkende Person ansehen' },
  fr: { original: 'Contribution originale', contributor: 'Voir la personne contributrice' },
  es: { original: 'Contribución original', contributor: 'Ver a la persona colaboradora' },
} satisfies Record<UiLocale, { original: string; contributor: string }>;
