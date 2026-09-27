// Feature catalogs, one line each, loaded as native-i18n namespaces. Git merges
// this file with the union driver (see .gitattributes), so parallel feature
// branches add their lines without conflicts; keep one entry per line.
export const catalogs = {
  auth: () => import('../features/auth/messages.ts').then(module => module.messages),
  discover: () => import('../features/discover/messages.ts').then(module => module.messages),
  home: () => import('../features/home/messages.ts').then(module => module.messages),
  search: () => import('../features/search/messages.ts').then(module => module.messages),
  shell: () => import('../features/shell/messages.ts').then(module => module.messages),
  studio: () => import('../features/studio/messages.ts').then(module => module.messages),
  work: () => import('../features/work/messages.ts').then(module => module.messages),
  workPage: () => import('../features/work-page/messages.ts').then(module => module.messages),
};
