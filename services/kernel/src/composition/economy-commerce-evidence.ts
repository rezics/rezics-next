import type { Pool } from 'pg';
import {
  isCommerceTestMoney,
  readCreatorFinancialSource,
  type CommerceTestMoney,
} from '../commerce/financial-evidence.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import { registerCommerceEvidence } from '../economy/storage/commerce-evidence.ts';
import { createNativeEconomyDatabase } from './economy.ts';

/** Internal evidence intake. The caller names a prior Commerce fact and supplies no economics. */
export function createNativeEconomyCommerceEvidence(
  pool: Pool,
  config: CommerceTestMoney & Readonly<{ bookId: string }>,
) {
  const environment = process.env.NODE_ENV;
  if (
    (environment !== 'development' && environment !== 'test') ||
    !isEconomyBookId(config.bookId) ||
    !isCommerceTestMoney(config)
  )
    throw new TypeError('Invalid Economy Commerce test evidence bindings');

  const { bookId, namespace, currency, mode } = config;
  const binding = { namespace, currency, mode, unit: Object.freeze({ ...config.unit }) };
  return {
    async register(input: Readonly<{ orderId: string; movementId: string; deadline: number }>) {
      const database = createNativeEconomyDatabase(pool, input.deadline);
      const result = await database.read(async (client) => ({
        kind: 'ok',
        value: await readCreatorFinancialSource(client, binding, input),
      }));
      if (result.kind !== 'ok') return result;
      const source = result.value;
      if (source.kind !== 'ok') return source;
      return registerCommerceEvidence(database, bookId, namespace, source.value);
    },
  };
}
