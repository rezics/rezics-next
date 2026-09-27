import { defineResources } from 'native-i18n';

// One catalog per feature and locale; en is the authoring contract.
export const resources = defineResources({
  fallbackLocale: 'en',
  loaders: {
    en: {
      common: () => import('../features/shell/messages/en.ts').then(module => module.default),
      auth: () => import('../features/auth/messages/en.ts').then(module => module.default),
      consent: () => import('../features/consent/messages/en.ts').then(module => module.default),
      account: () => import('../features/account/messages/en.ts').then(module => module.default),
      admin: () => import('../features/admin/messages/en.ts').then(module => module.default),
    },
    'zh-CN': {
      common: () => import('../features/shell/messages/zh-CN.ts').then(module => module.default),
      auth: () => import('../features/auth/messages/zh-CN.ts').then(module => module.default),
      consent: () => import('../features/consent/messages/zh-CN.ts').then(module => module.default),
      account: () => import('../features/account/messages/zh-CN.ts').then(module => module.default),
      admin: () => import('../features/admin/messages/zh-CN.ts').then(module => module.default),
    },
  },
});
