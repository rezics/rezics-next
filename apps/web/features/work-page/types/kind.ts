export type WorkPageKind = 'book' | 'recipe' | 'prompt' | 'skill' | 'guide';

/** The first matching semantic rdf:type chooses the Work's task-focused page. */
export function workPageKind(types: readonly string[]): WorkPageKind {
  if (types.includes('https://rezics.com/vocab/PromptTemplate')) return 'prompt';
  if (types.includes('https://rezics.com/vocab/SkillPackage')) return 'skill';
  if (types.includes('https://schema.org/Recipe')) return 'recipe';
  if (types.includes('https://schema.org/DigitalDocument')) return 'guide';
  return 'book';
}
