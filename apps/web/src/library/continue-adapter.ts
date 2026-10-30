import type { ContinueSource } from './continue-source';

/**
 * Integration boundary for the sole native libraryContinue producer in docs/library-continue.md.
 * The mounted controller and its generated caller are absent in this checkout. Replace this adapter with that
 * caller when delivered, including its real statuses and bounded header projection. Never probe a cast client,
 * walk libraryEntries/progressSessions, prepare on GET, or manufacture a successful empty page here.
 */
export const nativeContinueSource: ContinueSource = async () => ({ state: 'unavailable', reason: 'missing-binding' });
