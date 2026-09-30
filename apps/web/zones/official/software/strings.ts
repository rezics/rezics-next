const en = { featured: 'Featured apps', project: 'Project website', source: 'Source code',
  versionUnknown: 'Version not tracked', licenseUnknown: 'License not tracked',
  alternatives: 'alternatives', more: 'See all', untitled: 'Untitled app',
  platforms: 'Platforms', maintainedBy: 'Maintained by' };
type Strings = typeof en;
type ZoneLocale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja' | 'ko' | 'de' | 'fr' | 'es';
const zoneLocales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const satisfies readonly ZoneLocale[];
const translations: Record<ZoneLocale, Strings> = {
  en,
  'zh-Hans': { featured: '精选应用', project: '项目网站', source: '源代码',
    versionUnknown: '暂无版本记录', licenseUnknown: '暂无许可证记录',
    alternatives: '个替代选择', more: '查看全部', untitled: '未命名应用',
    platforms: '平台', maintainedBy: '维护者' },
  'zh-Hant': { featured: '精選應用', project: '專案網站', source: '原始碼',
    versionUnknown: '暫無版本紀錄', licenseUnknown: '暫無授權紀錄',
    alternatives: '個替代選擇', more: '查看全部', untitled: '未命名應用',
    platforms: '平台', maintainedBy: '維護者' },
  ja: { featured: '注目のアプリ', project: 'プロジェクトのサイト', source: 'ソースコード',
    versionUnknown: 'バージョンは未記録', licenseUnknown: 'ライセンスは未記録',
    alternatives: '件の代替', more: 'すべて見る', untitled: 'タイトル未設定のアプリ',
    platforms: 'プラットフォーム', maintainedBy: '保守' },
  ko: { featured: '추천 앱', project: '프로젝트 웹사이트', source: '소스 코드',
    versionUnknown: '버전이 기록되지 않음', licenseUnknown: '라이선스가 기록되지 않음',
    alternatives: '개의 대안', more: '모두 보기', untitled: '제목 없는 앱',
    platforms: '플랫폼', maintainedBy: '관리' },
  de: { featured: 'Vorgestellte Apps', project: 'Projektwebsite', source: 'Quellcode',
    versionUnknown: 'Version nicht erfasst', licenseUnknown: 'Lizenz nicht erfasst',
    alternatives: 'Alternativen', more: 'Alle ansehen', untitled: 'Unbenannte App',
    platforms: 'Plattformen', maintainedBy: 'Betreut von' },
  fr: { featured: 'Applications à la une', project: 'Site du projet', source: 'Code source',
    versionUnknown: 'Version non suivie', licenseUnknown: 'Licence non suivie',
    alternatives: 'alternatives', more: 'Tout voir', untitled: 'Application sans titre',
    platforms: 'Plateformes', maintainedBy: 'Maintenu par' },
  es: { featured: 'Aplicaciones destacadas', project: 'Sitio del proyecto', source: 'Código fuente',
    versionUnknown: 'Versión no registrada', licenseUnknown: 'Licencia no registrada',
    alternatives: 'alternativas', more: 'Ver todo', untitled: 'Aplicación sin título',
    platforms: 'Plataformas', maintainedBy: 'Mantenido por' },
};
export const localeStrings = translations;

export const strings = (locale: string): Strings =>
  (zoneLocales as readonly string[]).includes(locale) ? translations[locale as ZoneLocale] : en;
