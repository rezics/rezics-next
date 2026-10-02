import { defineMessages, indexCatalog } from '../../i18n/define.ts';

const en = { site: 'Site', community: 'Community' };
export const messages = defineMessages({ en,
  de: { site: 'Website', community: 'Community' },
  es: { site: 'Sitio', community: 'Comunidad' },
  fr: { site: 'Site', community: 'Communauté' },
  ja: { site: 'サイト', community: 'コミュニティ' },
  ko: { site: '사이트', community: '커뮤니티' },
  'zh-Hans': { site: '站点', community: '社区' },
  'zh-Hant': { site: '站點', community: '社群' },
});
export const surfaceText = indexCatalog(en, messages);
