import { writeFileSync } from 'node:fs';
import { compileCatalogue } from '../src/compile.ts';
import { bundledSources } from '../src/bundled.ts';

const { root, schemas, presentation, contexts, filters } = bundledSources();
const release = await compileCatalogue({ root, schemas, presentation, contexts, filters });
writeFileSync(new URL('../release/rezics.json', import.meta.url), `${JSON.stringify(release, null, 2)}\n`);
