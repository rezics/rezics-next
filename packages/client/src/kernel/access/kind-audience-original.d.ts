import type { AccessContext, Actor, PrepareReadDecisionsInput, ReadDecisions } from '../request/access.ts';
import type { KindAudienceAccess } from './kind-audience.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import { type AccessWork, type AccessWorkAccounting } from './work.ts';
export type KindOriginalIdentity = Readonly<{
    expires: number;
    account: unknown;
}>;
export type KindOriginalProducer = (actor: Actor, context: AccessContext) => KindOriginalIdentity | undefined;
type Request = Readonly<{
    actor: Actor;
    context: AccessContext & {
        time: AuthoritativeTime;
        work: AccessWorkAccounting;
    };
}>;
export declare function createKindAudienceOriginal(config: Readonly<{
    identity?: KindOriginalProducer;
    formulaDigest: string;
    formulaBound(request: Request): AccessWork | undefined;
    formulaOverhead(request: Request): WorkDimensions;
    prepareFormula(input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
    gates(request: Request, root: ReadDecisions): Promise<boolean>;
}>): KindAudienceAccess;
export {};
