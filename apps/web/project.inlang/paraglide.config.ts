export default {
  outdir: './src/paraglide',
  strategy: ['url', 'cookie', 'preferredLanguage', 'baseLocale'],
  urlPatterns: [
    { pattern: '/', localized: [['en', '/en'], ['zh-Hant', '/zh-Hant'], ['zh-Hans', '/zh-Hans'], ['ja', '/ja'], ['ko', '/ko'], ['de', '/de'], ['fr', '/fr'], ['es', '/es']] },
    { pattern: '/:path(.*)?', localized: [['en', '/en/:path(.*)?'], ['zh-Hant', '/zh-Hant/:path(.*)?'], ['zh-Hans', '/zh-Hans/:path(.*)?'], ['ja', '/ja/:path(.*)?'], ['ko', '/ko/:path(.*)?'], ['de', '/de/:path(.*)?'], ['fr', '/fr/:path(.*)?'], ['es', '/es/:path(.*)?']] },
  ],
};
