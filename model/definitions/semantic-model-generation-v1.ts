import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const semanticModelGenerationDeclaration = {
  id: 'semantic-model-generation-v1',
  canonical: {
    generation: { types: ['rv:ModelGeneration'] },
    head: { types: ['rv:ModelComponent'] },
  },
} as const satisfies TurtleDeclaration;

export const semanticModelGenerationProfile = parseTurtleProfile(
  semanticModelGenerationDeclaration.id,
  readFileSync(new URL('./semantic-model-generation-v1.ttl', import.meta.url), 'utf8'),
  semanticModelGenerationDeclaration,
);
