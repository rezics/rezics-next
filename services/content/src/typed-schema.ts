import { bigint, boolean, pgSchema, uuid } from 'drizzle-orm/pg-core';

// SQL migrations remain the DDL owner. This declaration types the one drizzle
// read of content.owner_control; every other Content query uses pg.
const content = pgSchema('content');

export const ownerControl = content.table('owner_control', {
  singleton: boolean('singleton').primaryKey(),
  dataEpoch: uuid('data_epoch').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
});
