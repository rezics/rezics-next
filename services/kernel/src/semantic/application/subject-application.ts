import type { DataType, Release } from '@rezics/definitions/contract';
import type { ItemApplication } from './item-application.ts';
import type { SubjectFactStorePort } from '../contract/domain-ports.ts';
import type { Item, ItemFact, ItemFactRow } from '../contract/item-values.ts';
import { GLOBAL_SUBJECT_CONTEXT, type SubjectFactPlan } from '../contract/subject-values.ts';
import { ITEM_FACT_LIMIT } from '../contract/item-values.ts';

export type SubjectFactsInput = Readonly<{
  subjectId: string;
  item: unknown;
  type: string;
  release: Release;
  releaseDigest: string;
}>;

export type SubjectWriteFactsInput<Tx> = SubjectFactsInput &
  Readonly<{
    tx: Tx;
    route: number;
    transactionId: string;
  }>;

export type SubjectApplication<Tx> = Readonly<{
  plan(input: SubjectFactsInput): SubjectFactPlan;
  project(
    plan: SubjectFactPlan,
    rows: readonly ItemFactRow[],
    metadata: { revision: number; release: string; context?: string; relationCounts?: Record<string, number> },
  ): Item;
  writePlannedFacts(input: SubjectWriteFactsInput<Tx>, plan: SubjectFactPlan): Promise<void>;
  initializeIdentity(tx: Tx, original: string): Promise<void>;
}>;

export function createSubjectApplication<Tx>(ports: {
  items: ItemApplication;
  facts: SubjectFactStorePort<Tx>;
}): SubjectApplication<Tx> {
  const { items, facts } = ports;
  return Object.freeze({
    plan(input) {
      const planned = items.factsForItem(input.subjectId, input.item, input.type, input.release);
      if (planned.length > ITEM_FACT_LIMIT) throw new TypeError('A subject accepts at most 512 facts');
      return {
        subjectId: input.subjectId,
        type: input.type,
        facts: planned,
        dataTypes: items.factDataTypes(input.release, planned),
        relationProperties: items.relationProperties(input.release, input.type),
      };
    },
    project(plan, rows, metadata) {
      const relationCounts =
        metadata.relationCounts ??
        Object.fromEntries(
          plan.relationProperties.map((property) => [
            property,
            plan.facts.filter((fact) => fact.kind === 'statement' && fact.property === property).length,
          ]),
        );
      return items.resolveItem(plan.subjectId, rows, plan.type, plan.dataTypes as Record<string, DataType>, {
        revision: metadata.revision,
        release: metadata.release,
        context: metadata.context ?? GLOBAL_SUBJECT_CONTEXT,
        relationCounts,
      });
    },
    async writePlannedFacts(input, plan) {
      await facts.writeFacts(input.tx, {
        route: input.route,
        subject_id: input.subjectId,
        transaction_id: input.transactionId,
        facts: items.storedFacts(plan.facts as ItemFact[], input.releaseDigest, input.release),
      });
    },
    initializeIdentity: (tx, original) => facts.initializeIdentity(tx, original),
  });
}
