/** Standalone mirror of the current Web caller DTO until the generated route declaration is delivered. */
export type PublicationCommand = Readonly<{
  method: 'POST';
  href: string;
  subjectId: string;
  expectedHead: string | null;
  ifMatch: string | null;
}>;

export type RealmPublicationPreparation = {
  realm: { realmId: string; spaceId: string; contextId: string; title: string; hostTitle: string };
  subject: { originalId: string; currentId: string; presentation: { state: 'unavailable' } };
  current: { publicationId: string; verdict: 'adopt' | 'withdraw' | 'reject'; decidedAt: string } | null;
  commands: {
    publish: PublicationCommand | null;
    withdraw: PublicationCommand | null;
    reject: PublicationCommand | null;
  };
  viewer: { accountId: string; clientId: string; authnEpoch: number };
  recovery: { requestIdentity: 'unknown'; replay: 'original-command' };
};

/** Response body for GET /realms/:realmId/publications/:subjectId/preparation. */
export type RealmPublicationPreparationResponse = { preparation: RealmPublicationPreparation };
