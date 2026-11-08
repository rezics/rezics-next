import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
export type CurrentClassificationAssociation = Readonly<{
    subjectId: string;
    subjectRoute: number;
    associationId: string;
    slotId: string;
    property: string;
    targetId: string;
    contextId: typeof GLOBAL_CONTEXT;
    release: string;
    revision: number;
    qualifiers: readonly unknown[];
    statementDigest: string;
    bindingHash: string;
}>;
/** Resolve one exact, currently selected Global classification statement. The returned digest binds
 * the original candidate, release, target and all qualifiers; it never follows redirects. */
export declare function readCurrentClassificationAssociation(input: {
    pool: Pool;
    access: Access;
    actor: Actor;
    subjectId: string;
    associationId: string;
    action: string;
    deadline: number;
    time?: AuthoritativeTime;
}): Promise<CurrentClassificationAssociation | null>;
