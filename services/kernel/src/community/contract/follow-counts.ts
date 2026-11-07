/** Space owns current existence and deletion semantics. A Follow reader borrows
 * the original native client and instant; it does not reconstruct Space policy. */
export interface CommunityFollowCountProducer<Client> {
  exists(client: Client, spaceId: string, at: string): Promise<boolean>;
}
