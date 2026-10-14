import { reader } from '../work-page/read.ts';
import { readSuppliedAllowedActions } from './allowed.ts';

/** The Work's allowed actions for the current viewer; none when signed out, without an Agent or when Main cannot say. */
export async function readAllowedActions(id: string): Promise<readonly string[]> {
  const { main, actingSubject } = await reader();
  return readSuppliedAllowedActions(main, id, actingSubject);
}
