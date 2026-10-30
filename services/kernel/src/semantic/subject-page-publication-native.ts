import type { Release } from '@rezics/definitions';
import type { CommandEvent, CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { isRelationProperty, type FactRow } from './item.ts';
import { slotView } from './slots.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import { loadRelated } from './subject.ts';
import { candidateSources, sourceTuple, fenceKey, fencedIds } from './fences.ts';
import readTermSupport from './terms-read-support.sql';
import type { Source } from '@rezics/definitions/bulk';
import { readFences } from '../content/source-fences.ts';
import type { ImportedFieldGroup } from '../content/imported-contract.ts';
import {
  readSubjectPageSourceOwner,
  retainSubjectPageSource,
  publicState,
  recordSubjectPageTransition,
  type ComponentKey,
  type ComponentTransition,
  type OwnerKey,
  type PublicState,
} from './subject-page-publication-store.ts';

export type PublicComponents = Map<string, { component: ComponentKey; state: PublicState; dependencies: OwnerKey[] }>;
const absent = { shown: false, digest: null };
/** The bounded native selected view, always using the public disclosure audience. */
export async function subjectPageSlot(
  tx: CommandTransaction,
  subject: string,
  property: string,
  slot: string,
  release: Release,
  routeKey?: Uint8Array,
): Promise<PublicComponents> {
  return withPublicStatementReader(async () => {
    const original = (await loadRelated(tx, [subject])).get(subject);
    if (!original || original.visibility !== 'visible' || original.redirect) return new Map();
    const view = await slotView(tx, subject, property, GLOBAL_CONTEXT, {}, slot);
    return subjectPageFacts(tx, subject, view.facts, release, routeKey);
  });
}
export async function subjectPageFacts(
  tx: CommandTransaction,
  subject: string,
  facts: readonly FactRow[],
  release: Release,
  routeKey?: Uint8Array,
): Promise<PublicComponents> {
  if (facts.length > 512) throw new RangeError('Public component input exceeds native write cap');
  const components: PublicComponents = new Map();
  const targets = [
    ...new Set(
      facts.flatMap((f) => {
        const body = f.body as { value?: { type: string; content?: unknown } };
        return f.kind === 'statement' &&
          body.value?.type === 'value' &&
          typeof body.value.content === 'string' &&
          routeOf(body.value.content) !== null &&
          isRelationProperty(release, f.property!)
          ? [body.value.content]
          : [];
      }),
    ),
  ];
  const owners = new Map<string, Awaited<ReturnType<typeof loadRelated>> extends Map<string, infer R> ? R : never>();
  for (let offset = 0; offset < targets.length; offset += 256)
    for (const [id, state] of await loadRelated(tx, targets.slice(offset, offset + 256))) owners.set(id, state);
  const redirected = [...new Set([...owners.values()].flatMap((owner) => (owner.redirect ? [owner.redirect] : [])))];
  for (let offset = 0; offset < redirected.length; offset += 256)
    for (const [id, state] of await loadRelated(tx, redirected.slice(offset, offset + 256))) owners.set(id, state);
  const labelLanguages = facts.filter((fact) => fact.kind === 'label').map((fact) => fact.language!);
  const supportRows =
    routeKey && labelLanguages.length
      ? await readTermSupport.run(tx, {
          route: routeOf(subject)!,
          subject_id: subject,
          entries: labelLanguages.map((language) => ({ kind: 'label', language })),
        })
      : null;
  const labelSupport = supportRows === null ? [] : Array.isArray(supportRows) ? supportRows : [supportRows];
  const hiddenLabels = routeKey
    ? await fencedIds(
        tx,
        routeKey,
        labelSupport.map((row) => ({
          id: row.language,
          source: row.source as Source | null,
        })),
      )
    : new Set<string>();
  for (const fact of facts) {
    if (fact.operation !== 'assert') continue;
    if (fact.kind === 'label' && fact.language) {
      const component: ComponentKey = { kind: 'label', key: fact.language };
      const source = labelSupport.find((row) => row.language === fact.language)?.source as Source | null | undefined;
      const tuple = routeKey && source && 'source' in source ? sourceTuple(routeKey, source) : null;
      const dependencies: OwnerKey[] = tuple
        ? [{ kind: 'source-fence', route: tuple.route, key: fenceKey(tuple) }]
        : [];
      components.set(`label:${fact.language}`, {
        component,
        state: hiddenLabels.has(fact.language) ? absent : publicState(fact.body),
        dependencies,
      });
    }
    if (fact.kind !== 'statement' || !fact.statement_id) continue;
    const body = fact.body as { rank?: string; value: { type: string; content?: unknown } };
    if (body.rank === 'deprecated') continue;
    const kind = isRelationProperty(release, fact.property!)
      ? 'relation'
      : fact.property === 'schema:image'
        ? 'cover'
        : 'fact';
    const dependencies: OwnerKey[] = [];
    let shown = true;
    if (kind === 'relation' && body.value.type === 'value') {
      const target = body.value.content;
      if (typeof target !== 'string' || routeOf(target) === null) continue;
      const state = owners.get(target);
      shown = state?.visibility === 'visible';
      dependencies.push({ kind: 'subject', route: routeOf(target)!, key: target });
      if (state?.redirect) {
        shown = shown && owners.get(state.redirect)?.visibility === 'visible';
        dependencies.push({ kind: 'subject', route: routeOf(state.redirect)!, key: state.redirect });
      }
    }
    let source = await readSubjectPageSourceOwner(tx, { route: routeOf(subject)!, id: subject }, fact.statement_id);
    if (!source && routeKey) {
      const imported = (
        await candidateSources(tx, [{ route: routeOf(subject)!, subject_id: subject, candidate_id: fact.statement_id }])
      ).get(`${subject}\n${fact.statement_id}`);
      if (imported && 'source' in imported) {
        await retainSubjectPageSource(tx, {
          subject: { route: routeOf(subject)!, id: subject },
          candidates: [fact.statement_id],
          source: imported,
          routeKey,
        });
        const tuple = sourceTuple(routeKey, imported);
        source = { kind: 'source-fence', route: tuple.route, key: fenceKey(tuple) };
      }
    }
    if (source) {
      dependencies.push(source);
      const [route, sourceName, externalId, fieldGroup] = JSON.parse(source.key) as [
        number,
        string,
        string,
        ImportedFieldGroup,
      ];
      const fences = await readFences(tx, [
        { route, source: sourceName, external_id: externalId, field_group: fieldGroup },
      ]);
      if (fences.some((fence) => fence.takenDown)) shown = false;
    }
    const component: ComponentKey = { kind, key: fact.statement_id };
    components.set(`${kind}:${fact.statement_id}`, {
      component,
      state: shown ? publicState({ property: fact.property, body: fact.body }) : absent,
      dependencies,
    });
  }
  return components;
}
export async function recordSubjectPageDiff(
  tx: CommandTransaction,
  subject: string,
  changeId: string,
  before: PublicComponents,
  after: PublicComponents,
  outbox: CommandEvent[],
) {
  const components: ComponentTransition[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key),
      next = after.get(key);
    components.push({
      component: (next ?? old)!.component,
      before: old?.state ?? absent,
      after: next?.state ?? absent,
      dependencies: next?.dependencies ?? [],
    });
  }
  await recordSubjectPageTransition(tx, {
    subject: { route: routeOf(subject)!, id: subject },
    changeId,
    components,
    outbox,
  });
}
export async function invalidateSubjectPage(
  tx: CommandTransaction,
  subject: string,
  changeId: string,
  outbox: CommandEvent[],
) {
  await recordSubjectPageTransition(tx, {
    subject: { route: routeOf(subject)!, id: subject },
    changeId,
    components: [],
    outbox,
    invalidateGate: true,
  });
}
