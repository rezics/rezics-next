const en = { featured: 'Featured games', details: 'Explore game', officialPage: 'Official page', recent: 'New and notable',
  reviewsUnknown: 'Review summary not tracked', released: 'Released', upcoming: 'Upcoming',
  more: 'See all', mods: 'Browse mods', platforms: 'Platforms', languages: 'Languages',
  releaseUnknown: 'Release date not tracked', by: 'by', untitled: 'Untitled game',
  tags: 'Tags', reviews: 'reviews' };
type Strings = typeof en;
type ZoneLocale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko' | 'de' | 'fr' | 'es';
const zoneLocales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const satisfies readonly ZoneLocale[];
const translations: Record<ZoneLocale, Strings> = {
  en,
  'zh-Hans': { featured: '精选游戏', details: '查看游戏', officialPage: '官方网站', recent: '近期新作',
    reviewsUnknown: '暂无评论汇总', released: '已发行', upcoming: '即将推出',
    more: '查看全部', mods: '浏览模组', platforms: '平台', languages: '语言',
    releaseUnknown: '暂无发行日期', by: '来自', untitled: '未命名游戏', tags: '标签', reviews: '条评论' },
  'zh-Hant': { featured: '精選遊戲', details: '查看遊戲', officialPage: '官方網站', recent: '新作與注目',
    reviewsUnknown: '暫無評論摘要', released: '已發行', upcoming: '即將推出',
    more: '查看全部', mods: '瀏覽模組', platforms: '平台', languages: '語言',
    releaseUnknown: '暫無發行日期', by: '來自', untitled: '未命名遊戲', tags: '標籤', reviews: '則評論' },
  ja: { featured: '注目のゲーム', details: 'ゲームを見る', officialPage: '公式サイト', recent: '新作と注目',
    reviewsUnknown: 'レビュー概要は未記録', released: '発売済み', upcoming: '発売予定',
    more: 'すべて見る', mods: 'Modを見る', platforms: 'プラットフォーム', languages: '言語',
    releaseUnknown: '発売日は未記録', by: '作者：', untitled: 'タイトル未設定のゲーム', tags: 'タグ', reviews: '件のレビュー' },
  ko: { featured: '추천 게임', details: '게임 살펴보기', officialPage: '공식 사이트', recent: '새로운 주목작',
    reviewsUnknown: '리뷰 요약이 기록되지 않음', released: '출시됨', upcoming: '출시 예정',
    more: '모두 보기', mods: '모드 둘러보기', platforms: '플랫폼', languages: '언어',
    releaseUnknown: '출시일이 기록되지 않음', by: '제작', untitled: '제목 없는 게임', tags: '태그', reviews: '개의 리뷰' },
  de: { featured: 'Vorgestellte Spiele', details: 'Spiel ansehen', officialPage: 'Offizielle Seite', recent: 'Neu und beachtenswert',
    reviewsUnknown: 'Keine Rezensionsübersicht erfasst', released: 'Erschienen', upcoming: 'Erscheint bald',
    more: 'Alle ansehen', mods: 'Mods ansehen', platforms: 'Plattformen', languages: 'Sprachen',
    releaseUnknown: 'Erscheinungsdatum nicht erfasst', by: 'von', untitled: 'Unbenanntes Spiel', tags: 'Tags', reviews: 'Rezensionen' },
  fr: { featured: 'Jeux à la une', details: 'Voir le jeu', officialPage: 'Page officielle', recent: 'Nouveautés à suivre',
    reviewsUnknown: 'Résumé des avis non suivi', released: 'Sorti', upcoming: 'À venir',
    more: 'Tout voir', mods: 'Parcourir les mods', platforms: 'Plateformes', languages: 'Langues',
    releaseUnknown: 'Date de sortie non suivie', by: 'par', untitled: 'Jeu sans titre', tags: 'Tags', reviews: 'avis' },
  es: { featured: 'Juegos destacados', details: 'Ver el juego', officialPage: 'Página oficial', recent: 'Novedades destacadas',
    reviewsUnknown: 'Resumen de reseñas no registrado', released: 'Publicado', upcoming: 'Próximamente',
    more: 'Ver todo', mods: 'Ver los mods', platforms: 'Plataformas', languages: 'Idiomas',
    releaseUnknown: 'Fecha de lanzamiento no registrada', by: 'por', untitled: 'Juego sin título', tags: 'Etiquetas', reviews: 'reseñas' },
};
export const localeStrings = translations;

export const strings = (locale: string): Strings =>
  (zoneLocales as readonly string[]).includes(locale) ? translations[locale as ZoneLocale] : en;
