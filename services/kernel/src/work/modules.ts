import type { WorkModule } from './registry.ts';
import { commerceWorkModule } from '../commerce/work-module.ts';
import { accountsWorkModule } from '../access/write-rate-expiry.ts';

/** Add each module's registration here, in dependency order, once. */
export const KERNEL_WORK_MODULES: readonly WorkModule[] = [accountsWorkModule, commerceWorkModule];
