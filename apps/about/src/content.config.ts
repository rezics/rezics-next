import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { legalLoader } from './legal/loader.ts';

/** The policies, rendered from `docs/legal/*.md`; see `src/legal/loader.ts`. */
const legal = defineCollection({
  loader: legalLoader(),
  schema: z.object({
    slug: z.string(),
    source: z.string(),
    digest: z.string(),
    draft: z.boolean(),
  }),
});

export const collections = { legal };
