import { iri } from '../work/activate.ts';
import { READING_POSITION_COST } from './contract.ts';

/** Expand only Work compositions. A generic property path through
 * ^rv:generation walks every chapter in a Book just to discover that none has
 * rv:composedWork. The profile guard stops at the Book before that join.
 * Fixed depth follows the reader's existing Work-depth contract; every branch
 * has a bound root, and chapter inventory never participates in the scope. */
export function readingWorkScope(root: string): string {
  const branches = [`{ BIND(${iri(root)} AS ?work) }`];
  for (let depth = 1; depth <= READING_POSITION_COST.workDepth; depth++) {
    const steps: string[] = [];
    for (let level = 0; level < depth; level++) {
      const source = level ? `?scopeWork${level}` : iri(root);
      const target = level === depth - 1 ? '?work' : `?scopeWork${level + 1}`;
      steps.push(`${source} rv:mainVersion ?scopeMain${level} .
        ?scopeStructure${level} rv:structureOf ?scopeMain${level} ;
          rv:structureProfile rv:WorkComposition ; rv:selectedGeneration ?scopeGeneration${level} .
        ?scopeGeneration${level} rv:generationState rv:Active .
        ?scopePlacement${level} rv:generation ?scopeGeneration${level} ; rv:composedWork ${target} .
        FILTER NOT EXISTS { ?scopePlacement${level} rv:removedBy ?scopeRemoved${level} }`);
    }
    branches.push(`{ ${steps.join('\n')} }`);
  }
  return branches.join('\nUNION\n');
}
