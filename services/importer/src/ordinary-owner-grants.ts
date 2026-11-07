/** Ordinary Global owner grants for importer review. Access maps a second insert of the same
 * grant row to 403 when the receipt key is a fresh UUID; the intent key replays as 409. */

export const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';

export const BOOK_OWNER_GRANT_ACTIONS = ['statement:propose', 'context:accept', 'context:adopt'] as const;

export type OrdinaryOwnerGrantResource = { route: number; id: string };

export function ordinaryOwnerGrantResource(): OrdinaryOwnerGrantResource {
  return { route: 0, id: GLOBAL_CONTEXT };
}

export function ordinaryOwnerGrantKey(resource: OrdinaryOwnerGrantResource, accountId: string, action: string): string {
  return `accounts.grant:${resource.route}:${resource.id}:${accountId}:${action}`;
}

export function ordinaryOwnerGrantBody(accountId: string, action: string) {
  return {
    resource: ordinaryOwnerGrantResource(),
    subject: { kind: 'account' as const, id: accountId },
    actions: [action],
    valid: '(,)',
  };
}

export function admitOrdinaryOwnerGrantStatus(status: number): boolean {
  return status === 201 || status === 409;
}

export async function grantOrdinaryOwnerActions(input: {
  accountId: string;
  actions: readonly string[];
  post: (request: {
    path: string;
    body: ReturnType<typeof ordinaryOwnerGrantBody>;
    idempotencyKey: string;
  }) => Promise<{ status: number; text: string }>;
}): Promise<void> {
  const resource = ordinaryOwnerGrantResource();
  for (const action of input.actions) {
    const result = await input.post({
      path: '/v1/grants',
      body: ordinaryOwnerGrantBody(input.accountId, action),
      idempotencyKey: ordinaryOwnerGrantKey(resource, input.accountId, action),
    });
    if (!admitOrdinaryOwnerGrantStatus(result.status))
      throw new Error(`Grant ${action} on ${resource.id} failed (${result.status}): ${result.text}`);
  }
}
