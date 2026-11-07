import type { KernelClient } from '@rezics/client';

type ContributionActionsRoute = ReturnType<KernelClient['accounts']>['contribution-actions']['post'];

/** The installed callable's request body; every reference, view and cursor type derives from it. */
export type AuthorContributionActionsRequest = Parameters<ContributionActionsRoute>[0];
export type AuthorContributionActionsResponse = NonNullable<Awaited<ReturnType<ContributionActionsRoute>>['data']>;

export type ContributionReference = Readonly<AuthorContributionActionsRequest['references'][number]>;
export type ContributionActionsInput = Readonly<{
  accountId: string;
  view: AuthorContributionActionsRequest['view'];
  cursor: string | null;
  proof: string;
  references: readonly ContributionReference[];
}>;

export interface AuthorContributionActionsWire<T = AuthorContributionActionsResponse> {
  /** One selected native read; the transport stays private and no-store. */
  read(input: ContributionActionsInput, signal: AbortSignal): Promise<T>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Top-level kinds only. The kernel's closed 200 schema validates the body before it leaves Content. */
function admitsResponse(value: unknown): value is AuthorContributionActionsResponse {
  return (
    record(value) &&
    record(value.viewer) &&
    Array.isArray(value.selected) &&
    record(value.reactions) &&
    record(value.actions) &&
    record(value.watch) &&
    record(value.currentness)
  );
}

/** One selected read through the installed callable. Non-200 and malformed bodies reject, which the receiver reports as failed. */
export function authorContributionActionsWire(client: KernelClient): AuthorContributionActionsWire {
  return {
    async read(input, signal) {
      const result = await client
        .accounts({ accountId: input.accountId })
        ['contribution-actions'].post(
          { proof: input.proof, references: [...input.references], view: input.view, cursor: input.cursor },
          { fetch: { cache: 'no-store', signal } },
        );
      if (result.status !== 200 || !admitsResponse(result.data))
        throw new Error(`Author contribution actions responded with ${result.status}`);
      return result.data;
    },
  };
}
