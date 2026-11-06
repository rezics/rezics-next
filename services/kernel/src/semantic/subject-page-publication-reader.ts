import type { CommandTransaction } from '../command/command.ts';
import type { ContentImportedFieldGroup as ImportedFieldGroup } from './contract/domain-ports.ts';
import { readFences } from '../content/source-fences.ts';
import { readRelease } from './definitions.ts';
import { subjectPageFacts, subjectPageSlot } from './subject-page-publication-native.ts';
import {
  readSubjectPageOwnerTime,
  type ComponentKey,
  type ComponentTransition,
  type EvidenceTime,
  type SubjectKey,
} from './subject-page-publication-store.ts';
import descriptive from './subject-page-publication-phase-descriptive.sql';
import relations from './subject-page-publication-phase-relations.sql';
import evidence from './subject-page-publication-phase-evidence.sql';
import label from './subject-page-publication-phase-label.sql';
import subjectRelease from './subject-page-publication-phase-release.sql';
import locate from './moderation-read-live-candidate.sql';
const ZERO = '00000000-0000-0000-0000-000000000000';
function rows<T>(value: T | T[] | null): T[] {
  return value === null ? [] : Array.isArray(value) ? value : [value];
}
export async function readSubjectPageNativeWindow(
  tx: CommandTransaction,
  input: {
    subject: SubjectKey;
    phase: 'descriptive' | 'relations' | 'evidence';
    after: string[];
    limit: number;
    sentinel: boolean;
  },
) {
  if (!Number.isInteger(input.limit) || input.limit < 0 || input.limit > 32)
    throw new RangeError('Native source budget exceeds 32');
  const params = {
    route: input.subject.route,
    subject_id: input.subject.id,
    limit: input.limit + Number(input.sentinel),
  };
  if (input.phase === 'evidence') {
    const found = rows(await evidence.run(tx, { ...params, after_id: input.after[0] ?? ZERO }));
    return {
      keys: found.slice(0, input.limit).map((row) => ({
        sourceKey: [row.candidate_id],
        component: {
          kind: (row.relation
            ? 'relation'
            : row.property === 'schema:image'
              ? 'cover'
              : 'fact') as ComponentKey['kind'],
          key: row.candidate_id,
        },
      })),
      hasMore: found.length > input.limit,
    };
  }
  const found = rows(
    await (input.phase === 'descriptive' ? descriptive : relations).run(tx, {
      ...params,
      after_slot: input.after[0] ?? ZERO,
      after_seq: Number(input.after[1] ?? 0),
    }),
  );
  return {
    keys: found.slice(0, input.limit).map((row) => ({
      // View metadata is nullable to the compiler; the underlying fact key is NOT NULL.
      sourceKey: [row.slot_id!, String(row.log_seq)],
      component: {
        kind: (row.kind === 'label'
          ? 'label'
          : input.phase === 'relations'
            ? 'relation'
            : row.property === 'schema:image'
              ? 'cover'
              : 'fact') as ComponentKey['kind'],
        key: row.kind === 'label' ? row.language! : (row.statement_id ?? ''),
      },
    })),
    hasMore: found.length > input.limit,
  };
}
/** Current state comes from the native public slot resolver, never the source window. */
export async function readSubjectPageNativeComponent(
  tx: CommandTransaction,
  subject: SubjectKey,
  component: ComponentKey,
  routeKey: Uint8Array,
): Promise<ComponentTransition & EvidenceTime> {
  const absent = { shown: false, digest: null };
  const result: ComponentTransition & EvidenceTime = {
    component,
    before: absent,
    after: absent,
    dependencies: [],
    effectiveAt: null,
    evidence: 'missing',
  };
  const releaseRow = rows(await subjectRelease.run(tx, { route: subject.route, subject_id: subject.id }))[0];
  const release = releaseRow?.current_release ? await readRelease(tx, releaseRow.current_release) : null;
  if (!release) return result;
  if (component.kind === 'label') {
    const facts = rows(await label.run(tx, { route: subject.route, subject_id: subject.id, language: component.key }));
    const current = (
      await subjectPageFacts(
        tx,
        subject.id,
        facts.map((fact) => ({ ...fact, kind: 'label' as const, operation: 'assert' as const })),
        release,
        routeKey,
      )
    ).get(`label:${component.key}`);
    if (current) {
      result.after = current.state;
      result.dependencies = current.dependencies;
    }
    return result;
  }
  if (!component.key) return result;
  const located = rows(
    await locate.run(tx, { route: subject.route, subject_id: subject.id, candidate_id: component.key }),
  )[0];
  if (!located) return result;
  const current = (await subjectPageSlot(tx, subject.id, located.property!, located.slot_id!, release, routeKey)).get(
    `${component.kind}:${component.key}`,
  );
  if (current) {
    result.after = current.state;
    result.dependencies = current.dependencies;
  }
  for (const owner of result.dependencies) {
    let time = await readSubjectPageOwnerTime(tx, owner);
    if (owner.kind === 'source-fence') {
      const [route, source, external_id, field_group] = JSON.parse(owner.key) as [
        number,
        string,
        string,
        ImportedFieldGroup,
      ];
      const fence = (await readFences(tx, [{ route, source, external_id, field_group }]))[0];
      if (fence?.takenDown && fence.takenDownAt && fence.takedownId)
        time = { effectiveAt: fence.takenDownAt, evidence: 'known' };
    }
    if (time.effectiveAt && (!result.effectiveAt || Date.parse(time.effectiveAt) > Date.parse(result.effectiveAt))) {
      result.effectiveAt = time.effectiveAt;
      result.evidence = 'known';
    }
  }
  return result;
}
