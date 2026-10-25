import type { OpenRecordBindings } from '../../../specs/imports-bindings-driver.ts';
import { RecordBindings } from '../src/record-bindings.ts';

/** Forward to production on the caller's probed handle; no test model or generated observations. */
export const openRecordBindings: OpenRecordBindings = (database) => new RecordBindings(database);
