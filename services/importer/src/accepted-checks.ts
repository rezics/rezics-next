import { checkBatchWrite, checkBatchWriteResult } from '@rezics/definitions/bulk';
import { checkCoverIntent, rememberAccepted } from '@rezics/conversion/support';

/**
 * Shared by every boundary that sees the same body: a record's journal, its public envelope and
 * its transport request are each validated once, however many modules they cross.
 */
export const checkRequest = checkCoverIntent;
export const checkBatch = rememberAccepted(checkBatchWrite, 64, 65536);
export const checkResult = rememberAccepted(checkBatchWriteResult, 64, 65536);
