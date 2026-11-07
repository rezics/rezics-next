/** Progress operation planning and admission. Catalog values are bound at composition; arithmetic is core. */

import type {
  AuthorizationCapability,
  IdentityDisclosureCapability,
  ProgressOperationAdmission,
  ProgressOperationApplication,
  ProgressOperationCatalog,
  SessionCommandOriginal,
  SessionOperationKind,
  SessionReadInput,
  SessionReadKind,
} from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import {
  admissionTerm,
  grantCapable,
  routeOf,
  sumAdmission,
  createProgressOperationBounds,
  sessionWorkOf,
} from '../core/index.ts';

export function createProgressOperationApplication(capabilities: {
  authorization: AuthorizationCapability;
  identityDisclosure: IdentityDisclosureCapability;
  progressCatalog: ProgressOperationCatalog;
}): ProgressOperationApplication {
  const bounds = createProgressOperationBounds(capabilities.progressCatalog);
  return {
    catalog: capabilities.progressCatalog,
    async admit(input: {
      actor: LibraryActor;
      deadline: number;
      subjectId?: string;
      at?: unknown;
      account?: Parameters<typeof grantCapable>[0];
    }): Promise<ProgressOperationAdmission> {
      const refused = (name: string, work: Parameters<typeof admissionTerm>[1] = {}) => ({
        admitted: false,
        actor: input.actor,
        deadline: input.deadline,
        original: null,
        terminal: null,
        admission: sumAdmission([admissionTerm(name, work)]),
      });

      if (!Number.isFinite(input.deadline) || Date.now() >= input.deadline)
        return refused('deadline', { statements: 1 });
      if (input.actor.kind !== 'account' || routeOf(input.actor.accountId) === null)
        return refused('actor', { statements: 1 });
      if (input.account && !grantCapable(input.account, input.actor))
        return refused('grant', { statements: 1, nativeRows: 1 });

      const subjectId = input.subjectId;
      if (!subjectId) {
        return {
          admitted: true,
          actor: input.actor,
          deadline: input.deadline,
          original: null,
          terminal: null,
          admission: sumAdmission([admissionTerm('progress-operation', { statements: 1, nativeRows: 1 })]),
        };
      }

      const disclosure = await capabilities.authorization.within(input.deadline, () =>
        capabilities.identityDisclosure.readOriginalTerminal({
          actor: input.actor,
          subjectId,
          deadline: input.deadline,
          at: input.at,
        }),
      );
      if (disclosure.original === null || disclosure.terminal === null)
        return refused('identity-disclosure-unavailable', { identityMetadataRows: 2, statements: 1 });

      return {
        admitted: true,
        actor: input.actor,
        deadline: input.deadline,
        original: disclosure.original,
        terminal: disclosure.terminal,
        admission: sumAdmission([
          admissionTerm('grant', { statements: 1, nativeRows: 1 }),
          admissionTerm('identity-disclosure', {
            identityMetadataRows: 2,
            nativePoints: 4,
            statements: 2,
            bytes: 8192,
          }),
          admissionTerm('progress-operation', { nativeRows: 2, statements: 2, nativePoints: 2 }),
        ]),
      };
    },
    planCommand(
      kind: SessionOperationKind,
      original: SessionCommandOriginal,
      receiptKeys: number,
      preparesSource = false,
      durationMs = 5000,
    ) {
      const plan = bounds.sessionCommandPlan(kind, original, receiptKeys, preparesSource, durationMs);
      return { kind: plan.kind, original: plan.original, total: sessionWorkOf(plan.total) };
    },
    planRead(kind: SessionReadKind, accountId: string, input: SessionReadInput) {
      const plan = bounds.sessionReadOperationPlan(kind, accountId, input);
      return { kind: plan.kind, original: plan.original, total: sessionWorkOf(plan.total) };
    },
    snapshotWork(accountId: string) {
      return sessionWorkOf(bounds.sessionSnapshotWork(accountId));
    },
    partitionWork(partition: number) {
      return sessionWorkOf(bounds.sessionPartitionWork(partition));
    },
    releaseWork(digest: string, active = false) {
      return sessionWorkOf(bounds.sessionReleaseWork(digest, active));
    },
    sourceWork(subjectId: string, withProfile: boolean) {
      return sessionWorkOf(bounds.sessionSourceWork(subjectId, withProfile));
    },
    headWork(input) {
      return sessionWorkOf(bounds.sessionHeadWork(input));
    },
    activityWork(input) {
      return sessionWorkOf(bounds.sessionActivityWork(input));
    },
    shelfWork(route: number, accountId: string, counters: boolean) {
      return sessionWorkOf(bounds.sessionShelfWork(route, accountId, counters));
    },
    profileMigrationWork(route: number, accountId: string) {
      return sessionWorkOf(bounds.sessionProfileMigrationWork(route, accountId));
    },
    readTimeWork() {
      return sessionWorkOf(bounds.sessionReadTimeWork());
    },
    presentationWork(measures: number, sessions = 1) {
      return sessionWorkOf(bounds.sessionPresentationWork(measures, sessions));
    },
    coreCommandAttemptWork(kind: string, accountId: string, receiptKeys: number, response: object) {
      return sessionWorkOf(bounds.sessionCoreCommandAttemptWork(kind, accountId, receiptKeys, response));
    },
  };
}

export type { ProgressOperationApplication };
