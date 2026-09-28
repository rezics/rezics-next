const en = { featured: 'Featured games', details: 'Explore game', officialPage: 'Official page', recent: 'New and notable',
  reviewsUnknown: 'Review summary not tracked', released: 'Released', upcoming: 'Upcoming',
  more: 'See all', mods: 'Browse mods', platforms: 'Platforms', languages: 'Languages',
  releaseUnknown: 'Release date not tracked', by: 'by', untitled: 'Untitled game',
  tags: 'Tags', reviews: 'reviews' };
type Strings = typeof en;
const translations: Record<string, Partial<Strings>> = {
  'zh-Hans': { featured: '精选游戏', details: '查看游戏', officialPage: '官方网站', recent: '近期新作',
    reviewsUnknown: '暂无评论汇总', released: '已发行', upcoming: '即将推出',
    more: '查看全部', mods: '浏览模组', platforms: '平台', languages: '语言',
    releaseUnknown: '暂无发行日期', by: '来自', untitled: '未命名游戏', tags: '标签', reviews: '条评论' },
  'zh-Hant': { featured: '精選遊戲', details: '查看遊戲', officialPage: '官方網站', reviewsUnknown: '暫無評論摘要',
    released: '已發行', upcoming: '即將推出', more: '查看全部', mods: '瀏覽模組', platforms: '平台',
    languages: '語言', releaseUnknown: '暫無發行日期', untitled: '未命名遊戲', tags: '標籤', reviews: '則評論' },
};
export const strings = (locale: string): Strings => ({ ...en, ...translations[locale] });
