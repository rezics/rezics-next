import type { LibraryActor } from './actors.ts';
export type BuiltinMemberOptions<Query> = {
    limit?: number;
    cursor?: string | null;
    deadline?: number;
    query?: Query;
};
/** Native Source, owner truth and cursor execution remain the existing single maintained implementation. */
export interface BuiltinMemberCapability<View, Query, Member> {
    read(actor: LibraryActor, id: string, deadline: number): Promise<View | null>;
    proveEmpty(actor: LibraryActor, source: View, deadline: number): Promise<boolean>;
    readPage(actor: LibraryActor, id: string, options: BuiltinMemberOptions<Query> & {
        limit: number;
        deadline: number;
        revalidateOwner(): Promise<void>;
        readSourceVersion(): Promise<string>;
    }): Promise<{
        members: Member[];
        next: string | null;
    }>;
    sourceVersion(actor: LibraryActor, source: View, deadline: number): Promise<string>;
    deadline(): number;
    invalidRequest(): Error;
    notFound(): Error;
}
