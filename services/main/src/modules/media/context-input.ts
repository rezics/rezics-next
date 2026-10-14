import { t } from 'elysia';
import { DEFAULT_MEDIA_CONTEXT } from './contract.ts';

/** Decode the platform selection name before authority, digests and owner storage. */
export const mediaContextInput = t.Codec(t.Union([
  t.Literal('urn:rezics:context:global'),
  t.Literal(DEFAULT_MEDIA_CONTEXT),
  t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
])).Decode(context => context === 'urn:rezics:context:global' ? DEFAULT_MEDIA_CONTEXT : context)
  .Encode(context => context);
