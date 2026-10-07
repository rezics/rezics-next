import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const semanticRuleDeclaration = {
  id: 'semantic-rule-v1',
  canonical: {
    slot: { types: ['rv:ContextRule'] },
    revision: { types: ['rv:FiniteRuleRevision'] },
    dependency: { types: ['rv:RuleDependency'] },
    'dependency-page': { types: ['rv:RuleDependencyPage'] },
  },
} as const satisfies TurtleDeclaration;

export const semanticRuleProfile = parseTurtleProfile(
  semanticRuleDeclaration.id,
  readFileSync(new URL('./semantic-rule-v1.ttl', import.meta.url), 'utf8'),
  semanticRuleDeclaration,
);
