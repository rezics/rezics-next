import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const driver = pathToFileURL(
  resolve(import.meta.dir, '../../../../services/kernel/test/access/account-lifecycle-outcome-driver.ts'),
).href;
process.env.ACCOUNT_LIFECYCLE_OUTCOME_DRIVER = driver;

// The suite loads the driver inside its 30 s hook; load the product modules before any hook runs.
await import(driver);
await import('../../../../specs/account-lifecycle-outcomes.test.ts');
