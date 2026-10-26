import { pathToFileURL } from 'node:url';

process.env.DURABLE_INITIATOR_DRIVER_MODULE = pathToFileURL(
  `${import.meta.dir}/durable-initiator-outcome-driver.ts`,
).href;

await import('../../../../specs/durable-initiator-outcomes.test.ts');
