import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NATIVE_ACCOUNT_WORKFLOW_DRIVER_MODULE = pathToFileURL(
  resolve(import.meta.dir, '../../../../services/kernel/test/access/native-account-workflow-outcome-driver.ts'),
).href;

await import('../../../../specs/native-account-workflow-outcomes.test.ts');
