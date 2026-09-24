import { defineResources } from 'native-i18n';

export const resources = defineResources({
  fallbackLocale: 'en',
  loaders: {
    en: {
      shell: () => import('./en.ts').then(module => module.shell),
      home: () => import('./en.ts').then(module => module.home),
      search: () => import('./en.ts').then(module => module.search),
      auth: () => import('./en.ts').then(module => module.auth),
      work: () => import('./en.ts').then(module => module.work),
      studio: () => import('./en.ts').then(module => module.studio),
    },
    'zh-CN': {
      shell: () => import('./zh-CN.ts').then(module => module.shell),
      home: () => import('./zh-CN.ts').then(module => module.home),
      search: () => import('./zh-CN.ts').then(module => module.search),
      auth: () => import('./zh-CN.ts').then(module => module.auth),
      work: () => import('./zh-CN.ts').then(module => module.work),
      studio: () => import('./zh-CN.ts').then(module => module.studio),
    },
  },
});

export type UiLocale = 'en' | 'zh-CN';
