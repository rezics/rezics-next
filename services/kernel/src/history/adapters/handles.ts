import type { Pool } from 'pg';
import type { WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import type { WorkClient } from '../../work/client.ts';
import type {
  IdentitySourceConsumerCustody,
  IdentitySourceConsumerReference,
} from '../../semantic/identity-source-consumer-custody.ts';
import type { IdentitySourceConsumerMaintenanceWork } from '../../semantic/identity-source-consumer-maintenance.ts';
import type { AccountErasureSearchObservation } from '../../search/account-erasure-source.ts';
import {
  type HistoryConsumerReference,
  type HistoryHandle,
  type HistoryPool,
  type HistoryReceivingContext,
  type HistoryWorkClient,
  type HistoryWriterState,
} from '../contract/index.ts';

/**
 * Native values behind the opaque handles that History contracts carry. Each handle was created by the owner
 * that now reads it; these narrowings never validate, and every use site keeps its own owner checks.
 */
export const nativePool = (pool: HistoryPool): Pool => pool as Pool;
export const nativeWorkClient = (client: HistoryWorkClient): WorkClient => client as WorkClient;
export const nativeConsumerReference = (reference: HistoryConsumerReference): IdentitySourceConsumerReference =>
  reference as IdentitySourceConsumerReference;
export const nativeConsumerCustody = (custody: HistoryHandle): IdentitySourceConsumerCustody =>
  custody as IdentitySourceConsumerCustody;
export const nativeMaintenanceWork = (
  work: HistoryHandle | undefined,
): IdentitySourceConsumerMaintenanceWork | undefined => work as IdentitySourceConsumerMaintenanceWork | undefined;
export const nativeSearchObservation = (
  observation: HistoryHandle | undefined,
): AccountErasureSearchObservation | undefined => observation as AccountErasureSearchObservation | undefined;
export const nativeWriterState = (writer: HistoryWriterState): WorkflowWriterState =>
  writer as unknown as WorkflowWriterState;
/** The receiving context with the Semantic and Search values it actually carries. */
export const nativeReceivingContext = (
  context: HistoryReceivingContext,
): Readonly<{
  deadline: number;
  discriminant?: HistoryReceivingContext['discriminant'];
  identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
  accountErasureSearchObservation?: AccountErasureSearchObservation;
  recoveryReceivingReserved?: boolean;
}> =>
  context as Readonly<{
    deadline: number;
    discriminant?: HistoryReceivingContext['discriminant'];
    identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
    accountErasureSearchObservation?: AccountErasureSearchObservation;
    recoveryReceivingReserved?: boolean;
  }>;
/** The optional search observation a recovery readiness check accepts, present only when the receiving carries one. */
export const searchObservationSource = (
  observation: HistoryHandle | undefined,
): Readonly<{ searchObservation?: AccountErasureSearchObservation }> =>
  observation === undefined ? {} : { searchObservation: observation as AccountErasureSearchObservation };
