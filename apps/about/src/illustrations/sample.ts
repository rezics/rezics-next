/**
 * Sample works for the illustrations. They are invented so no real title is
 * implied; each keeps its own language, as real catalogue data would.
 */
export const lantern = {
  author: 'Mira Sato',
  editions: [
    { id: '7d1f9a4c-3b2e-4c58-9a0e-1f6b2c3d4e51', lang: 'en', title: 'The Lantern Archive' },
    { id: '2a6c8e10-5d47-4f93-b1a8-9c0d7e6f5a42', lang: 'zh-Hant', title: '燈籠書庫' },
    { id: '9e3b5d72-0c81-4a6f-8d24-6b1a3c7e9f03', lang: 'ja', title: '灯籠の書庫' },
  ],
} as const;

export const series = {
  english: { lang: 'en', title: 'Salt Marsh Chronicle' },
  chinese: { lang: 'zh-Hant', title: '鹽澤紀事' },
} as const;
