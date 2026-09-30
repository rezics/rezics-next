const en = { featured: 'Featured apps', project: 'Project website', source: 'Source code',
  versionUnknown: 'Version not tracked', licenseUnknown: 'License not tracked',
  alternatives: 'alternatives', more: 'See all', untitled: 'Untitled app',
  platforms: 'Platforms', maintainedBy: 'Maintained by' };
type Strings = typeof en;
const translations: Record<string, Partial<Strings>> = {
  'zh-Hans': { featured: '精选应用', project: '项目网站', source: '源代码',
    versionUnknown: '暂无版本记录', licenseUnknown: '暂无许可证记录',
    alternatives: '个替代选择', more: '查看全部', untitled: '未命名应用',
    platforms: '平台', maintainedBy: '维护者' },
};
export const localeStrings = translations;

export const strings = (locale: string): Strings => ({ ...en, ...translations[locale] });
