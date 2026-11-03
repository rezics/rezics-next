/** The installed KernelClient has no publication preparation method yet.
 * This local caller port mirrors the native reference slice, not a second wire producer.
 * Full optional presentation remains with that same native resource's continuation.
 */
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
  commands: { publish: PublicationCommand | null; withdraw: PublicationCommand | null; reject: PublicationCommand | null };
  viewer: { accountId: string; clientId: string; authnEpoch: number };
  recovery: { requestIdentity: 'unknown'; replay: 'original-command' };
};
export type PublicationPreparationResult =
  | { kind: 'ready'; preparation: RealmPublicationPreparation }
  | { kind: 'denied' }
  | { kind: 'unavailable'; seam?: 'generated-publication-preparation' };
export type PublicationPrepare = (input: {
  realmId: string;
  subjectId: string;
}) => Promise<PublicationPreparationResult>;

export const unavailablePublicationPreparation: PublicationPrepare = async () => ({
  kind: 'unavailable',
  seam: 'generated-publication-preparation',
});

export function publicationCommandHref(realmId: string, subjectId: string, action: 'publish' | 'withdraw' | 'reject') {
  const base = `/v1/realms/${realmId}/publications`;
  return action === 'publish' ? base : `${base}/${subjectId}:${action}`;
}

/** Advice is only eligible for the existing command; that command reauthorizes at execution. */
export function admittedPublicationCommand(
  preparation: RealmPublicationPreparation,
  action: 'publish' | 'withdraw' | 'reject',
): PublicationCommand | null {
  const command = preparation.commands[action];
  const head = preparation.current?.publicationId ?? null;
  if (
    !command || command.method !== 'POST' || command.subjectId !== preparation.subject.originalId ||
    command.href !== publicationCommandHref(preparation.realm.realmId, preparation.subject.originalId, action) ||
    command.expectedHead !== head || command.ifMatch !== (head === null ? null : JSON.stringify(head)) ||
    (action !== 'publish' && head === null)
  ) return null;
  return command;
}
