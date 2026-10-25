import { resolve } from 'node:path';

import '../support/stable-match-object.ts';

process.env.LIBRARY_DRIVER = resolve(import.meta.dir, 'support/outcome-driver.ts');
await import('../../../../specs/library-outcomes.test.ts');
