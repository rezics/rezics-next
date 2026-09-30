import { reader } from '../work-page/read.ts';

// Whether the viewer may edit a Work is Main's answer, never the page's: the Work's generic page
// read (`/v1/resources/{id}/page`) lists the actions the viewer may take on each section, and
// `work.edit` is there only when Access admits the viewer's Agent to edit this Work.

/** The action Main names for changing a Work's parts, relations, realizations and releases. */
export const EDIT_ACTION = 'work.edit';

/** Every action the viewer may take on the Work, from a page read's sections. */
export function allowedActionsOf(page: { sections?: readonly { actions: readonly string[] }[] } | null | undefined): readonly string[] {
  return [...new Set((page?.sections ?? []).flatMap(section => section.actions))];
}

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

export const mayEdit = (allowed: readonly string[]) => allowed.includes(EDIT_ACTION);
