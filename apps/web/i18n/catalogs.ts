// Feature catalogs, one line each, loaded as native-i18n namespaces. Git merges
// this file with the union driver (see .gitattributes), so parallel feature
// branches add their lines without conflicts; keep one entry per line.
export const catalogs = {
  // Transitional: the session layer moves these strings to features/auth/messages.ts.
  auth: () => Promise.all([import('./en.ts'), import('./zh-CN.ts')]).then(([en, zh]) => ({ en: en.auth, 'zh-CN': zh.auth })),
  home: () => import('../features/home/messages.ts').then(module => module.messages),
  search: () => import('../features/search/messages.ts').then(module => module.messages),
  shell: () => import('../features/shell/messages.ts').then(module => module.messages),
  studio: () => import('../features/studio/messages.ts').then(module => module.messages),
  work: () => import('../features/work/messages.ts').then(module => module.messages),
};
