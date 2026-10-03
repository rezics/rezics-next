import { bootstrapDatasetAdmin } from './bootstrap.ts';

if (process.argv.slice(2).length)
  throw new Error(
    'task dataset:bootstrap-admin takes no arguments; use REZICS_DATASET_STACK for another local stack',
  );
try {
  console.log(await bootstrapDatasetAdmin());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
