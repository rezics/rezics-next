import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll } from 'bun:test';

const driver = pathToFileURL(
  resolve(import.meta.dir, '../../../../services/kernel/test/access/permission-outcome-driver.ts'),
).href;
process.env.PERMISSION_DRIVER_MODULE = driver;

// Registering people takes seconds; prepare them here, where no case's time budget applies.
const { preparePermissionFixtures } = await import(driver);
await preparePermissionFixtures();

await import('../../../../specs/permission-outcomes.test.ts');

// The driver clones one prepared pair of databases for every case; drop that pair once the file is done.
afterAll(async () => {
  const { releasePermissionFixtures } = await import(driver);
  await releasePermissionFixtures();
}, 30_000);
