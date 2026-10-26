import { setDefaultTimeout } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Every protected step is revoked by each of eleven facts, and each case seeds real Auth accounts.
setDefaultTimeout(1_800_000);
process.env.ACCOUNT_AUTHORIZATION_DRIVER_MODULE = pathToFileURL(
  resolve(import.meta.dir, '../../../../services/kernel/test/access/account-authorization-outcome-driver.ts'),
).href;

await import('../../../../specs/account-authorization-outcomes.test.ts');
