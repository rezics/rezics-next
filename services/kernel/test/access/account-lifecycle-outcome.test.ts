import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.ACCOUNT_LIFECYCLE_OUTCOME_DRIVER = pathToFileURL(
  resolve(import.meta.dir, '../../../../services/kernel/test/access/account-lifecycle-outcome-driver.ts'),
).href;

await import('../../../../specs/account-lifecycle-outcomes.test.ts');
