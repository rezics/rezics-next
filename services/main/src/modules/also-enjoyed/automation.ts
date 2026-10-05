import type { PoolClient } from 'pg';
import { DISCOVERY_SERVICE_PRINCIPAL } from '../discovery/automation.ts';
import { authorizeManager, type ManageContext } from '../recommendation/derived-generation.ts';

/** Server-only authority for the scheduled public co-reader population. */
const automation = Symbol('also-enjoyed-refresh');
export const automaticCoReaders = { [automation]: true } as const;
export type CoReaderOperator = ManageContext | typeof automaticCoReaders;
export const coReaderOperator = (client: PoolClient, context: CoReaderOperator) =>
  automation in context
    ? Promise.resolve(DISCOVERY_SERVICE_PRINCIPAL)
    : authorizeManager(client, context);
