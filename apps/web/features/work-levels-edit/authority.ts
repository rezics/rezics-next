import { reader } from '../work-page/read.ts';
import { allowedActionsOf } from './allowed.ts';

/** The Work's allowed actions for the current viewer; none when signed out, without an Agent or when Main cannot say. */
export async function readAllowedActions(id: string): Promise<readonly string[]> {
  const { main, actingSubject } = await reader();
  if (!actingSubject) return [];
  try {
    const { data } = await main.v1.resources({ resource: id }).page.get({ query: { actingSubject } });
    return allowedActionsOf(data);
  } catch {
    return [];
  }
}
