import { openGrowthDatabase } from '../../../kernel/test/support/growth.ts';
import { installNativeRoleProducer } from '../../src/erasure-coverage.ts';

/** Opt in when raw fixture SQL represents a current Auth writer after the producer cut. */
export async function openAuthGrowthDatabase(url: string) {
  const database = await openGrowthDatabase(url);
  installNativeRoleProducer(database.admin);
  return database;
}
