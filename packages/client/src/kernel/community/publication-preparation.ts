import type { KernelClient } from '../../index.ts';

/** Public aliases follow the installed generated preparation method. */
type RealmPath = ReturnType<KernelClient['realms']>;
type PublicationPath = ReturnType<RealmPath['publications']>;
type PreparationRead = Awaited<ReturnType<PublicationPath['preparation']['get']>>;
export type RealmPublicationPreparationResponse = NonNullable<PreparationRead['data']>;
export type RealmPublicationPreparation = RealmPublicationPreparationResponse['preparation'];
export type PublicationCommand = RealmPublicationPreparation['commands']['publish'];
