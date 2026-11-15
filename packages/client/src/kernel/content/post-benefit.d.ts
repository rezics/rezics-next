import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { ReadContext } from './model.ts';
import type { ContentPostBenefit } from '../access/authenticated-benefit.ts';
export type ContentPostSaleAuthority = Readonly<{
    benefit: ContentPostBenefit;
    creatorAccountId: string;
    targetSubjectId: string;
}>;
export type ContentPostSaleDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
}>;
/** Content's native post-sale authority port. Commerce stores only the returned
 * immutable Post/action terms; this authority is not a read grant or body copy.
 */
export declare function readContentPostSaleAuthority(dependencies: ContentPostSaleDependencies, postId: string, context: ReadContext, targetSubjectId?: string): Promise<ContentPostSaleAuthority | null>;
/** Settlement verifies the stable Post source identity without impersonating a
 * seller. Actual buyer bytes remain behind ordinary Content disclosure checks.
 */
export declare function readContentPostMechanicalSaleAuthority(dependencies: ContentPostSaleDependencies, postId: string, targetSubjectId: string, context: Readonly<{
    deadline: number;
}>): Promise<ContentPostSaleAuthority | null>;
