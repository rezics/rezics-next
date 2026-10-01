'use server';

import { parseLanguage } from '@rezics/main/language';
import { mainApi } from '../api/main.ts';
import { readWorkHeader, reader } from '../work-page/read.ts';
import { isRelationKind, viaOf } from './kinds.ts';
import { isPending, idFrom, problemOf, receiptOf, type Values, valuesOf, type WriteState, writeKey } from './write.ts';
import { workIdFrom, workIri } from './route.ts';

// The edit forms' server actions. Each checks only the shape of what was typed, asks Main to write
// it as the session's Agent with the head the page showed, and answers with Main's receipt or
// Main's refusal. No rule about grain, cycles, coverage or numbering lives here: Main's problems
// carry them.

type Answer = { data: unknown; error: { status: number; value?: unknown } | null };
/** What a write callback answers when the shape of the input is wrong: the field to fix. */
type Shape = { refused: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const httpsUrl = /^https:\/\/\S{1,2040}$/;
const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

const refused = (values: Values, field: string): WriteState =>
  ({ status: 'error', problem: 'invalid', detail: null, field, values });

function settle(answer: Answer, values: Values): WriteState {
  if (answer.error) return { status: 'error', ...problemOf(answer.error), field: null, values };
  if (isPending(answer.data)) return { status: 'pending', values };
  const receipt = receiptOf(answer.data);
  return receipt ? { status: 'done', ...receipt, nonce: crypto.randomUUID() }
    : { status: 'error', problem: 'unavailable', detail: null, field: null, values };
}

/** Runs one write as the session's Agent; a person without one is asked to sign in. */
async function asAgent(form: FormData, write: (context: { main: Awaited<ReturnType<typeof mainApi>>; actingSubject: string;
  values: Values }) => Promise<WriteState | Shape>): Promise<WriteState> {
  const values = valuesOf(form);
  const { actingSubject } = await reader();
  if (!actingSubject) return { status: 'error', problem: 'sign-in', detail: null, field: null, values };
  try {
    const result = await write({ main: await mainApi(), actingSubject, values });
    return 'refused' in result ? refused(values, result.refused) : result;
  } catch {
    return { status: 'error', problem: 'unavailable', detail: null, field: null, values };
  }
}

const workOf = (form: FormData): string | null => {
  const id = text(form, 'work');
  return uuid.test(id) ? id : null;
};

/** `changeParts` intents: one action serves every control on the parts list. */
const inclusions = ['required', 'optional', 'extra'] as const;
const positionOf = (value: string) => value === 'first' || value === 'last' ? value
  : iriPattern.test(value) ? { after: value } : null;

export async function changeParts(_previous: WriteState, form: FormData): Promise<WriteState> {
  const work = workOf(form);
  if (!work) return refused(valuesOf(form), 'work');
  return asAgent(form, async ({ main, actingSubject, values }) => {
    const intent = text(form, 'intent');
    const head = text(form, 'head');
    let structure = text(form, 'structure');
    const label = text(form, 'label');
    const inclusion = text(form, 'inclusion') || 'required';
    const occurrence = text(form, 'occurrence');
    const labelOk = label.length >= 1 && label.length <= 500 && (inclusions as readonly string[]).includes(inclusion);
    const at = positionOf(text(form, 'after') || 'last');
    if (!at) return { refused: 'after' };
    let operation: Record<string, unknown>;
    if (intent === 'add') {
      const target = workIdFrom(text(form, 'target'));
      if (!target) return { refused: 'target' };
      if (!labelOk) return { refused: 'label' };
      operation = { op: 'insert', parent: structure, position: at, role: 'part', target: workIri(target),
        displayLabel: label, inclusion };
    } else if (intent === 'move' && iriPattern.test(occurrence)) {
      operation = { op: 'move', occurrence, parent: structure, position: at };
    } else if (intent === 'remove' && iriPattern.test(occurrence)) {
      operation = { op: 'remove', occurrence };
    } else if (intent === 'update' && iriPattern.test(occurrence)) {
      if (!labelOk) return { refused: 'label' };
      operation = { op: 'update', occurrence, displayLabel: label, inclusion };
    } else return { refused: 'intent' };

    let expected = head;
    if (!structure) {
      // The first part of a Work starts its composition: Main creates it empty at the Work's Main Version.
      if (intent !== 'add') return { refused: 'structure' };
      const header = await readWorkHeader(work, 'en');
      if (!header.ok) return { status: 'error', problem: 'unavailable', detail: null, field: null, values };
      const created = await main.v1.compositions.post({ profile: 'work-composition', work: workIri(work),
        mainVersion: header.data.mainVersion, actingSubject },
      { headers: { 'idempotency-key': await writeKey(['create-composition', work, actingSubject]) } });
      if (created.error || isPending(created.data) || !('structure' in created.data)) return settle(created, values);
      structure = created.data.structure;
      expected = created.data.revision ?? '';
      operation = { ...operation, parent: structure };
    }
    const key = await writeKey(['parts', intent, work, structure, expected, actingSubject, JSON.stringify(operation)]);
    return settle(await main.v1.compositions({ id: structure.slice(-36) }).changes.post(
      { profile: 'work-composition', expectedHead: expected, operations: [operation] as never, actingSubject },
      { headers: { 'idempotency-key': key } }), values);
  });
}

export async function recordRelation(_previous: WriteState, form: FormData): Promise<WriteState> {
  const work = workOf(form);
  if (!work) return refused(valuesOf(form), 'work');
  return asAgent(form, async ({ main, actingSubject, values }) => {
    const kind = text(form, 'kind');
    const other = workIdFrom(text(form, 'counterpart'));
    const evidence = text(form, 'evidence');
    if (!isRelationKind(kind)) return { refused: 'kind' };
    if (!other || other === work) return { refused: 'counterpart' };
    if (!httpsUrl.test(evidence)) return { refused: 'evidence' };
    if (viaOf(kind) === 'derivation') {
      const unresolved = text(form, 'unresolved') === 'on';
      const head = text(form, 'head');
      const mainVersion = text(form, 'mainVersion');
      if (!iriPattern.test(head) || !iriPattern.test(mainVersion)) return { refused: 'kind' };
      const source = unresolved ? null : await main.v1.works({ id: other }).get({ query: { actingSubject } });
      if (source?.error) return settle(source, values);
      const key = await writeKey(['derivation', kind, work, other, head, evidence, String(unresolved), actingSubject]);
      return settle(await main.v1.resources({ resource: work }).derivations.post({ profile: 'work-derivation-v2',
        targetMainVersion: mainVersion, expectedTargetHead: head, sourceWork: workIri(other),
        sourceMainVersion: source?.data?.mainVersion ?? null, sourceMainRevision: source?.data?.mainVersionRevision ?? null,
        kind, evidence, actingSubject }, { headers: { 'idempotency-key': key } }), values);
    }
    const definition = await main.v1.lexicon.definitions({ key: kind }).get({ query: { actingSubject } });
    if (definition.error) return settle(definition, values);
    const subject = definition.data.workSubjectRole;
    const roles = (definition.data.roles as { key: string }[]).map(role => role.key);
    const counterpartRole = roles.find(role => role !== subject);
    if (!subject || !counterpartRole) return { refused: 'kind' };
    const key = await writeKey(['relation', kind, work, other, definition.data.revision, evidence, actingSubject]);
    return settle(await main.v1.relations.changes.post({ profile: 'relation-change-v1', expectedHead: null,
      definition: definition.data.revision, evidence, actingSubject,
      participations: [{ role: counterpartRole, participant: { kind: 'resource', ref: workIri(other) } },
        { role: subject, participant: { kind: 'resource', ref: workIri(work) } }] },
    { headers: { 'idempotency-key': key } }), values);
  });
}

const agentsOf = (input: string): string[] | null => {
  const ids = input.split(/[\s,]+/).filter(Boolean).map(workIdFrom);
  return ids.every((id): id is string => id !== null) ? [...new Set(ids.map(workIri))] : null;
};

export async function addRealization(_previous: WriteState, form: FormData): Promise<WriteState> {
  const work = workOf(form);
  if (!work) return refused(valuesOf(form), 'work');
  return asAgent(form, async ({ main, actingSubject, values }) => {
    const language = text(form, 'language');
    const kind = text(form, 'kind') === 'original' ? 'original' : 'translation';
    const status = text(form, 'status') === 'official' ? 'official' : 'unofficial';
    const verification = text(form, 'verification') === 'verified' ? 'verified' : 'unverified';
    const evidence = text(form, 'evidence');
    const translators = agentsOf(text(form, 'translators'));
    const publishers = agentsOf(text(form, 'publishers'));
    if (!parseLanguage(language)) return { refused: 'language' };
    if (!translators) return { refused: 'translators' };
    if (!publishers) return { refused: 'publishers' };
    if (evidence && !httpsUrl.test(evidence)) return { refused: 'evidence' };
    const me = text(form, 'translatorMe') === 'on' ? [actingSubject] : [];
    const chosen = text(form, 'source');
    const [, realization, revision] = chosen.match(/^realization:([0-9a-f-]{36}):([0-9a-f-]{36})$/) ?? [];
    const source = realization ? { kind: 'realization' as const, work: workIri(work), realization: workIri(realization),
      revision: workIri(revision!) }
      : chosen === 'main-version' && iriPattern.test(text(form, 'mainVersion')) && iriPattern.test(text(form, 'mainRevision'))
        ? { kind: 'main-version' as const, work: workIri(work), mainVersion: text(form, 'mainVersion'),
          revision: text(form, 'mainRevision') }
        : { kind: 'unresolved' as const, work: workIri(work) };
    const key = await writeKey(['realization', work, actingSubject, JSON.stringify(Object.entries(values))]);
    const id = await idFrom(key, 'realization');
    return settle(await main.v1.works({ id: work }).realizations({ realization: id }).put({ profile: 'realization-v1',
      expectedHead: null, actingSubject, id: workIri(id), language, kind,
      translators: kind === 'translation' ? [...new Set([...me, ...translators])] : [], publishers, source, status,
      verification, evidence: evidence || null }, { headers: { 'idempotency-key': key } }), values);
  });
}

const identifiersOf = (input: string) => {
  const lines = input.split('\n').map(line => line.trim()).filter(Boolean);
  const parsed = lines.map(line => line.match(/^(https:\/\/\S+)\s+(\S.*)$/));
  return parsed.every(Boolean) ? parsed.map(match => ({ provider: match![1]!, value: match![2]!.trim() })) : null;
};

export async function addRelease(_previous: WriteState, form: FormData): Promise<WriteState> {
  const work = workOf(form);
  if (!work) return refused(valuesOf(form), 'work');
  return asAgent(form, async ({ main, actingSubject, values }) => {
    const title = text(form, 'title');
    const language = text(form, 'language');
    const kind = text(form, 'kind');
    const status = text(form, 'status');
    const isbn13 = text(form, 'isbn13').replace(/[\s-]/g, '');
    const year = text(form, 'year');
    const territory = text(form, 'territory').toUpperCase();
    const identifiers = identifiersOf(text(form, 'identifiers'));
    const entries = form.getAll('coverage').map(String).flatMap(item => {
      const [realization, revision] = item.split(' ');
      return iriPattern.test(realization ?? '') && iriPattern.test(revision ?? '') ? [{ realization: realization!, revision: revision! }] : [];
    });
    if (!title || title.length > 500) return { refused: 'title' };
    if (!parseLanguage(language)) return { refused: 'language' };
    if (!['formal', 'web', 'fixed', 'virtual'].includes(kind)) return { refused: 'kind' };
    if (!['official', 'unofficial', 'virtual', 'withdrawn', 'cancelled'].includes(status)) return { refused: 'status' };
    if (isbn13 && !/^97[89][0-9]{10}$/.test(isbn13)) return { refused: 'isbn13' };
    if (year && !/^[0-9]{1,4}$/.test(year)) return { refused: 'year' };
    if (territory && !/^(?:[A-Z]{2}|[0-9]{3})$/.test(territory)) return { refused: 'territory' };
    if (!identifiers) return { refused: 'identifiers' };
    if (!entries.length || entries.length !== form.getAll('coverage').length) return { refused: 'coverage' };
    const completeness = ['complete', 'partial', 'trial', 'unknown'].includes(text(form, 'completeness'))
      ? text(form, 'completeness') as 'complete' : 'complete';
    const portion = text(form, 'portion');
    const key = await writeKey(['release', work, actingSubject, JSON.stringify(Object.entries(values))]);
    const id = await idFrom(key, 'release');
    return settle(await main.v1.works({ id: work }).releases({ release: id }).put({ profile: 'release-v2', expectedHead: null,
      actingSubject, id: workIri(id), kind: kind as 'formal', status: status as 'official',
      title: { value: title, language }, titleLanguage: language, tracklistLanguage: null,
      editionStatement: text(form, 'edition') || null, publisher: text(form, 'publisher') || null,
      publicationYear: year ? Number(year) : null, isbn13: isbn13 || null, originalUrl: null, fixedRelease: null,
      evidence: null, identifiers, platform: text(form, 'platform') || null, territory: territory || null,
      coverage: entries.map(entry => ({ ...entry, completeness, ...(portion ? { portion } : {}) })) },
    { headers: { 'idempotency-key': key } }), values);
  });
}
