import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded } from '../../infrastructure/fuseki.ts';
import { WorkReadLimit, type WorkReadSession } from '../work/read-session.ts';

/** Optional owner data may disappear, but hydration cannot evade the page's
 * shared deadline, graph-call or byte budgets. Admission never uses this helper. */
export async function optionalPreview<T>(session: WorkReadSession, read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error) {
    session.checkDeadline();
    if (error instanceof WorkReadLimit || error instanceof FusekiReadBudgetExceeded
      || error instanceof FusekiQueryResponseTooLarge) throw error;
    return null;
  }
}
