import type {
  CommunityAccess,
  CommunityAmbient,
  CommunityClock,
  CommunityDeadline,
  CommunityPool,
} from './vocabulary.ts';

export type CommunityWorkModule = Readonly<{
  name: string;
  register(context: unknown): Promise<void> | void;
}>;

export type CommunityEffectOperands = Readonly<{
  pool: CommunityPool;
  clock: CommunityClock;
  client: unknown;
}>;

export type CommunityDeclaredEffects = (operands: CommunityEffectOperands) => readonly unknown[];

export type CommunityMembershipDependencies = Readonly<{
  pool: CommunityPool;
  access: CommunityAccess;
  clock: CommunityClock;
  [key: string]: unknown;
}>;

export type CommunityAccessPort = {
  createMembership(dependencies: CommunityMembershipDependencies): unknown;
  createParticipation(
    input: Readonly<{ pool: CommunityPool; access: CommunityAccess; [key: string]: unknown }>,
  ): unknown;
};

export type CommunityEffectPort = {
  effects(operands: CommunityEffectOperands): readonly unknown[];
};

/** Private preparation observation. The mounted route owns its response schema. */
export type CommunityPublicationPreparationInput = Readonly<{
  dependencies: object;
  realmId: string;
  subjectId: string;
  context: Readonly<{ actor: object; deadline: number; languages?: readonly string[] }>;
}>;
export type CommunityPublicationPreparationObservation = Readonly<{
  preparation: object;
  components: readonly Readonly<{ partition: number; epoch: number; position: bigint }>[];
}>;
export type CommunityPublicationPreparationPort = Readonly<{
  read(input: CommunityPublicationPreparationInput): Promise<CommunityPublicationPreparationObservation | null>;
}>;

export type CommunityApplicationPorts = {
  readonly access: CommunityAccessPort;
  readonly effects: CommunityEffectPort;
  readonly publicationPreparation: CommunityPublicationPreparationPort;
  readonly ambient: CommunityAmbient;
};

export type CommunitySurfaceDeclaration = Readonly<{
  name: 'community';
  ambient: CommunityAmbient;
  events: () => Readonly<Record<string, unknown>>;
  work: CommunityWorkModule;
  effects: CommunityDeclaredEffects;
  createMembership: CommunityAccessPort['createMembership'];
  createParticipation: CommunityAccessPort['createParticipation'];
}>;

export type CommunityHttpDeclaration = Readonly<{
  name: 'community';
  ambient: CommunityAmbient;
  actions: unknown;
  viewerResources: readonly (readonly [string, unknown])[];
  routes(app: unknown, dependencies: unknown): unknown;
}>;

export type CommunityApplication = {
  readonly ports: CommunityApplicationPorts;
  readonly ambient: CommunityAmbient;
  elapsed(deadline: CommunityDeadline): boolean;
  remainingBudgetMs(deadline: CommunityDeadline): number;
  effects(operands: CommunityEffectOperands): readonly unknown[];
  readPublicationPreparation(
    input: CommunityPublicationPreparationInput,
  ): Promise<CommunityPublicationPreparationObservation | null>;
  createMembership(dependencies: CommunityMembershipDependencies): unknown;
  createParticipation(
    input: Readonly<{ pool: CommunityPool; access: CommunityAccess; [key: string]: unknown }>,
  ): unknown;
};
