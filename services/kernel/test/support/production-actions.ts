import { testReceiptKeys } from './receipt-keys.ts';
import { Pool } from 'pg';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { nativeSubjectReadingApplication } from '../../src/semantic/adapters/index.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';

/** Mount production routes without invoking handlers or opening a database connection. */
export function productionActions(): ActionCatalogue {
  const pool = new Pool({ connectionString: 'postgres://kernel.invalid/production-actions' });
  return actionCatalogue(
    createKernel({
      pool,
      receiptKeys: testReceiptKeys(),
      routeKey: new Uint8Array(32),
      subjectReading: nativeSubjectReadingApplication(),
    }),
  );
}
