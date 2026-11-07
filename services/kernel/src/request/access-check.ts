/** Request compatibility leaf; Access owns the prepared-check WeakMap identity. */
export {
  accessCheck,
  accessExplicitCheck,
  prepareReadDecisions,
  installPreparedAccessCheckWork,
  nativePreparedAccessCheckWork,
  resourcePage,
  validReadDecisionActions,
} from '../access/check.ts';
