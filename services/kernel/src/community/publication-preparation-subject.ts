import {
  AccessUnavailableError,
  CommandUnavailableError,
} from "../access/unavailable.ts";
import { readPartition } from "../partition/partition.ts";
import { accessCheck } from "../request/access.ts";
import { partitionOf, routeOf } from "../route/route.ts";
import { withRequestDeadline } from "../request/deadline.ts";
import { subjectReadEligibility } from "../semantic/eligibility.ts";
import { SubjectRedirectError } from "../semantic/merges.ts";
import { readSubjectReference } from "../semantic/references.ts";
import type { SubjectComponent } from "../semantic/subject.ts";
import type {
  PublicationDependencies,
  PublicationReadContext,
} from "./publication.ts";

type Reference = Readonly<{
  id: string;
  redirect: string | null;
  component: SubjectComponent;
}>;
export type PreparationSubject = Readonly<{
  originalId: string;
  currentId: string;
  components: readonly SubjectComponent[];
  current(): Promise<boolean>;
}>;

/** Consume Semantic's ordinary reference owner, including its redirect signal.
 * No labels, body, account identity or raw foreign tables enter this adapter.
 */
async function reference(
  deps: PublicationDependencies,
  id: string,
  context: PublicationReadContext,
) {
  const route = routeOf(id);
  if (route === null) return null;
  const check = await accessCheck(
    deps.access,
    context.actor,
    "subject:read",
    { route, id, eligibility: subjectReadEligibility({ route, id }) },
    { pool: deps.pool, deadline: context.deadline },
  );
  let component: SubjectComponent | undefined;
  try {
    const value = await withRequestDeadline(context.deadline, () =>
      readSubjectReference(deps.pool, id, async (client) => {
        // The reference owner's RR checkout is also the native component anchor.
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new AccessUnavailableError("contention");
        if (partition.writeState !== "active")
          throw new CommandUnavailableError(
            partition.writeState,
            partition.partitionNo,
            partition.movedTo,
          );
        component = {
          partition: partition.partitionNo,
          epoch: partition.epoch,
          position: partition.position,
        };
        return check(client);
      }),
    );
    return value
      ? { id: value.id, redirect: null, component: value.component }
      : null;
  } catch (error) {
    if (!(error instanceof SubjectRedirectError)) throw error;
    if (!component || error.from !== id)
      throw new AccessUnavailableError("contention");
    return { id, redirect: error.to, component };
  }
}

function same(left: Reference, right: Reference | null) {
  return (
    right !== null &&
    left.id === right.id &&
    left.redirect === right.redirect &&
    left.component.partition === right.component.partition &&
    left.component.epoch === right.component.epoch &&
    left.component.position === right.component.position
  );
}

/** A recorded publication keeps its original key. At most one terminal identity
 * supplies disclosed context; an unsettled second redirect withholds the read.
 * Every check prepares native Access again after releasing the preceding home.
 */
export async function preparePublicationSubject(
  deps: PublicationDependencies,
  subjectId: string,
  context: PublicationReadContext,
): Promise<PreparationSubject | null> {
  const original = await reference(deps, subjectId, context);
  if (!original) return null;
  const terminal = original.redirect
    ? await reference(deps, original.redirect, context)
    : original;
  if (!terminal) return null;
  if (terminal.redirect) throw new AccessUnavailableError("contention");
  const references = terminal === original ? [original] : [original, terminal];
  return {
    originalId: original.id,
    currentId: terminal.id,
    components: references.map((entry) => entry.component),
    async current() {
      for (const entry of references)
        if (!same(entry, await reference(deps, entry.id, context)))
          return false;
      return true;
    },
  };
}
