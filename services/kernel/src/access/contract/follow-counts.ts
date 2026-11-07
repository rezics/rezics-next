/** Native account observations supplied to derived Follow readers. This is not an
 * authorization decision or a public identity fallback. Pending rows stay absent. */
export type AccessFollowCountAccount = Readonly<{
  state: string;
  fenced: boolean;
  minimumAuthnEpoch: bigint;
}>;

export interface AccessFollowCountProducer<Client, Pool> {
  account(client: Client, route: number, accountId: string): Promise<AccessFollowCountAccount | null>;
  accountForAgent(pool: Pool, agentId: string): Promise<string | null>;
}
