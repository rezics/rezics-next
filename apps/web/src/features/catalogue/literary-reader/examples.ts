import type { LiteraryWorkIdentity } from './model';

export const literaryWorkExample = {
  identity: {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000911',
    title: { text: 'The harbour', lang: 'en' },
    titles: [
      { language: 'en', text: 'The harbour' },
      { language: 'ja', text: '港' },
    ],
    aliases: [{ language: 'en', text: 'Harbour stories' }],
    descriptions: [{ language: 'en', text: 'A novel about a changing port town.' }],
  } satisfies LiteraryWorkIdentity,
  locale: 'en',
  editionHref: '/en/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000911/editions',
  factsHref: '/en/subjects/0192f3a0-6c1e-7b2a-9d4e-000000000911/details',
};
