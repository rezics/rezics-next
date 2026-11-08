import { t } from 'elysia';
import { deadlineClient, accessCheck, withReadTransaction, readSubjectSummaryObservation } from './domain-ports.ts';
import { AccessUnavailableError, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import { spaceReadEligibility } from './space-read.ts';
import { realmReadEligibility } from './realm-read.ts';
import type { PublicationDependencies, PublicationReadContext, PublicationVerdict } from './publication.ts';
import { preparePublicationSubject } from './publication-preparation-subject.ts';
import read from './publication-preparation-read.sql';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableId = t.Union([id, t.Null()]);
export const PUBLICATION_PREPARATION_MAX_UTF8_BYTES = 128 * 1024;
const MAX_PRESENTATION_TEXT_LENGTH = 4096;
const MAX_PRESENTATION_VALUE_BYTES = 25 * 1024;
const MAX_PRESENTATION_COVER_BYTES = 12 * 1024;
const command = t.Object(
  {
    method: t.Literal('POST'),
    href: t.String(),
    subjectId: id,
    expectedHead: nullableId,
    ifMatch: t.Union([t.String(), t.Null()]),
  },
  closed,
);
const presentationLabel = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      value: t.String({ maxLength: MAX_PRESENTATION_TEXT_LENGTH }),
      language: t.String({ maxLength: 64 }),
    },
    closed,
  ),
  t.Object({ state: t.Literal('empty') }, closed),
  t.Object({ state: t.Literal('concealed') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);
const presentationCover = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      value: t.Object(
        {
          media: id,
          width: t.Integer({ minimum: 1 }),
          height: t.Integer({ minimum: 1 }),
          placeholder: t.Object(
            { thumbhash: t.String({ maxLength: 44 }), color: t.String({ pattern: '^#[0-9a-f]{6}$' }) },
            closed,
          ),
          variants: t.Array(
            t.Object(
              { format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer({ minimum: 1 }) },
              closed,
            ),
            { maxItems: 12 },
          ),
          focalPoint: t.Union([t.Object({ x: t.Number(), y: t.Number() }, closed), t.Null()]),
          credit: t.Object(
            {
              rightsHolder: t.String({ maxLength: 1024 }),
              via: t.Object({ name: t.String({ maxLength: 1024 }), url: t.String({ maxLength: 1024 }) }, closed),
              license: t.String({ maxLength: 128 }),
              obligations: t.Array(t.String({ maxLength: 8192 }), { maxItems: 2048 }),
            },
            closed,
          ),
        },
        closed,
      ),
    },
    closed,
  ),
  t.Object({ state: t.Literal('empty') }, closed),
  t.Object({ state: t.Literal('concealed') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);
const presentation = t.Object({ label: presentationLabel, cover: presentationCover }, closed);
const titlePresentation = t.Union([
  t.Object({ state: t.Literal('available'), value: t.String({ maxLength: MAX_PRESENTATION_TEXT_LENGTH }) }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);

export const PublicationPreparationSchema = t.Object(
  {
    realm: t.Object(
      {
        realmId: id,
        spaceId: id,
        contextId: id,
        title: titlePresentation,
        hostTitle: titlePresentation,
      },
      closed,
    ),
    subject: t.Object(
      {
        originalId: id,
        currentId: id,
        presentation: t.Object({ original: presentation, terminal: presentation }, closed),
      },
      closed,
    ),
    current: t.Union([
      t.Object(
        {
          publicationId: id,
          verdict: t.Union([t.Literal('adopt'), t.Literal('reject'), t.Literal('withdraw')]),
          decidedAt: t.String({ format: 'date-time' }),
        },
        closed,
      ),
      t.Null(),
    ]),
    commands: t.Object(
      {
        publish: command,
        withdraw: t.Union([command, t.Null()]),
        reject: t.Union([command, t.Null()]),
      },
      closed,
    ),
    recovery: t.Object(
      {
        requestIdentity: t.Literal('unknown'),
        replay: t.Literal('original-command'),
      },
      closed,
    ),
    viewer: t.Object({ accountId: id, clientId: t.String({ maxLength: 255 }), authnEpoch: t.Integer() }, closed),
  },
  closed,
);
export const PublicationPreparationResponseSchema = t.Object({ preparation: PublicationPreparationSchema }, closed);

type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type Observation = Readonly<{ row: Row; component: SessionComponent }>;
type Account = Extract<Actor, { kind: 'account' }>;

async function realmChecks(
  deps: PublicationDependencies,
  realmId: string,
  context: PublicationReadContext,
  spaceId?: string,
) {
  const route = routeOf(realmId)!;
  const resource = { route, id: realmId };
  const accessContext = { pool: deps.pool, deadline: context.deadline };
  // Membership and successful disclosure do not substitute for the actual action.
  const publish = await accessCheck(deps.access, context.actor, 'realm:publish', resource, accessContext);
  const realm = await accessCheck(
    deps.access,
    context.actor,
    'realm:read',
    { ...resource, eligibility: realmReadEligibility(resource) },
    accessContext,
  );
  const host = spaceId
    ? await accessCheck(
        deps.access,
        context.actor,
        'space:read',
        {
          route,
          id: spaceId,
          eligibility: spaceReadEligibility({ route, id: spaceId }),
        },
        accessContext,
      )
    : null;
  return { publish, realm, host };
}

async function observe(
  deps: PublicationDependencies,
  realmId: string,
  subjectId: string,
  context: PublicationReadContext,
  checks: Awaited<ReturnType<typeof realmChecks>>,
): Promise<Observation | null> {
  const route = routeOf(realmId)!;
  return withReadTransaction(
    deps.pool,
    async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) throw new AccessUnavailableError('contention');
      if (partition.writeState !== 'active')
        throw new CommandUnavailableError(partition.writeState, partition.partitionNo, partition.movedTo);
      const time = await mintReadTime(client, deps.clock);
      if (!(await checks.publish(client, time)) || !(await checks.realm(client, time))) return null;
      if (checks.host && !(await checks.host(client, time))) return null;
      const row = await read.run(client, {
        route,
        realm: realmId,
        subject: subjectId,
        at: authoritativeTimeValue(time),
      });
      if (!row || row.ownership_state !== 'owned') return null;
      return {
        row,
        component: {
          partition: partition.partitionNo,
          epoch: partition.epoch,
          position: partition.position,
        },
      };
    },
    context.deadline,
  );
}

function same(before: Observation, after: Observation) {
  return (
    JSON.stringify(before.row) === JSON.stringify(after.row) &&
    before.component.epoch === after.component.epoch &&
    before.component.position === after.component.position
  );
}

function destination(href: string, subjectId: string, head: string | null) {
  return {
    method: 'POST' as const,
    href,
    subjectId,
    expectedHead: head,
    ifMatch: head === null ? null : JSON.stringify(head),
  };
}

const textEncoder = new TextEncoder();

/** Count JSON UTF-8 bytes incrementally and stop as soon as the supplied cap is crossed. */
function boundedJsonBytes(value: unknown, limit: number): number | null {
  let bytes = 0;
  const add = (amount: number) => {
    bytes += amount;
    return bytes <= limit;
  };
  const textBytes = (text: string) => textEncoder.encode(JSON.stringify(text)).byteLength;
  const visit = (current: unknown): boolean => {
    if (current === null) return add(4);
    if (typeof current === 'string') return add(textBytes(current));
    if (typeof current === 'number' || typeof current === 'boolean')
      return add(textEncoder.encode(JSON.stringify(current)).byteLength);
    if (Array.isArray(current)) {
      if (!add(2)) return false;
      for (let index = 0; index < current.length; index++) {
        if ((index > 0 && !add(1)) || !visit(current[index])) return false;
      }
      return true;
    }
    if (typeof current === 'object') {
      const entries = Object.entries(current);
      if (!add(2)) return false;
      let first = true;
      for (const [key, entry] of entries) {
        if (entry === undefined) continue;
        if ((!first && !add(1)) || !add(textBytes(key)) || !add(1) || !visit(entry)) return false;
        first = false;
      }
      return true;
    }
    return add(4);
  };
  return visit(value) ? bytes : null;
}

function titleValue(value: string) {
  const result = { state: 'available' as const, value };
  return value.length <= MAX_PRESENTATION_TEXT_LENGTH && boundedJsonBytes(result, MAX_PRESENTATION_VALUE_BYTES)
    ? result
    : { state: 'unavailable' as const };
}

function presentationValue(
  summary: SubjectSummary | null,
  coverState: 'available' | 'absent' | 'concealed' | undefined,
) {
  const candidateLabel = summary?.label
    ? { state: 'available' as const, value: summary.label.value, language: summary.label.language }
    : null;
  const label = !summary
    ? { state: 'concealed' as const }
    : !candidateLabel
      ? { state: 'empty' as const }
      : candidateLabel.value.length <= MAX_PRESENTATION_TEXT_LENGTH &&
          candidateLabel.language.length <= 64 &&
          boundedJsonBytes(candidateLabel, MAX_PRESENTATION_VALUE_BYTES)
        ? candidateLabel
        : { state: 'unavailable' as const };
  const cover =
    coverState === 'absent'
      ? emptyCover()
      : coverState === 'concealed'
        ? concealedCover()
        : coverState !== 'available' || !summary?.cover
          ? unavailableCover()
          : boundedJsonBytes(summary.cover, MAX_PRESENTATION_COVER_BYTES) === null
            ? unavailableCover()
            : { state: 'available' as const, value: summary.cover };
  return {
    label,
    cover,
  };
}

function unavailablePresentation() {
  return { label: unavailableLabel(), cover: unavailableCover() };
}
function unavailableLabel() {
  return { state: 'unavailable' as const };
}
function unavailableCover() {
  return { state: 'unavailable' as const };
}
function emptyCover() {
  return { state: 'empty' as const };
}
function concealedCover() {
  return { state: 'concealed' as const };
}
type SubjectPresentation = ReturnType<typeof presentationValue> | ReturnType<typeof unavailablePresentation>;
type SubjectPresentations = Readonly<{ original: SubjectPresentation; terminal: SubjectPresentation }>;

/** Project only selected ids by map lookup; unrelated admitted summaries are never scanned. */
export function projectPublicationPresentations(
  originalId: string,
  terminalId: string,
  summaries: ReadonlyMap<string, SubjectSummary | null>,
  covers: ReadonlyMap<string, 'available' | 'absent' | 'concealed'>,
): SubjectPresentations {
  const selected = new Map<string, SubjectPresentation>();
  for (const id of new Set([originalId, terminalId])) {
    selected.set(id, presentationValue(summaries.get(id) ?? null, covers.get(id)));
  }
  return { original: selected.get(originalId)!, terminal: selected.get(terminalId)! };
}

function response(
  realmId: string,
  subjectId: string,
  currentId: string,
  row: Row,
  actor: Account,
  subjectPresentation: SubjectPresentations,
) {
  const base = `/v1/realms/${realmId}/publications`;
  const head = row.publication_id;
  if (row.verdict !== null && !['adopt', 'reject', 'withdraw'].includes(row.verdict))
    throw new TypeError('Invalid native publication verdict');
  if ((head === null) !== (row.verdict === null) || (head !== null && row.decided_at === null))
    throw new TypeError('Incomplete native publication head');
  return {
    realm: {
      realmId,
      spaceId: row.space_id,
      contextId: row.context_id,
      title: titleValue(row.realm_title),
      hostTitle: titleValue(row.space_title),
    },
    subject: {
      originalId: subjectId,
      currentId,
      presentation: subjectPresentation,
    },
    current:
      head === null
        ? null
        : {
            publicationId: head,
            verdict: row.verdict as PublicationVerdict,
            decidedAt: new Date(row.decided_at!).toISOString(),
          },
    commands: {
      publish: destination(base, subjectId, head),
      withdraw: head === null ? null : destination(`${base}/${subjectId}:withdraw`, subjectId, head),
      reject: head === null ? null : destination(`${base}/${subjectId}:reject`, subjectId, head),
    },
    recovery: {
      requestIdentity: 'unknown' as const,
      replay: 'original-command' as const,
    },
    viewer: {
      accountId: actor.accountId,
      clientId: actor.clientId,
      authnEpoch: actor.authnEpoch,
    },
  };
}

function boundedPreparation(preparation: ReturnType<typeof response>) {
  const bounded = structuredClone(preparation);
  const fits = () => boundedJsonBytes({ preparation: bounded }, PUBLICATION_PREPARATION_MAX_UTF8_BYTES) !== null;
  const fallbacks = [
    () => {
      if (bounded.subject.presentation.original.cover.state === 'available')
        bounded.subject.presentation.original.cover = unavailableCover();
    },
    () => {
      if (bounded.subject.presentation.terminal.cover.state === 'available')
        bounded.subject.presentation.terminal.cover = unavailableCover();
    },
    () => {
      if (bounded.subject.presentation.original.label.state === 'available')
        bounded.subject.presentation.original.label = unavailableLabel();
    },
    () => {
      if (bounded.subject.presentation.terminal.label.state === 'available')
        bounded.subject.presentation.terminal.label = unavailableLabel();
    },
    () => {
      if (bounded.realm.title.state === 'available') bounded.realm.title = { state: 'unavailable' };
    },
    () => {
      if (bounded.realm.hostTitle.state === 'available') bounded.realm.hostTitle = { state: 'unavailable' };
    },
  ];
  for (const fallback of fallbacks) {
    if (fits()) break;
    fallback();
  }
  if (!fits()) throw new RangeError('Publication preparation exceeds its UTF-8 response budget');
  return bounded;
}

/** Exact operational inspection. All dependencies are prepared on released homes;
 * final equality is conservative, never a claim of a global atomic snapshot.
 * No receipt, mutation, idempotency key or repair participates in this GET.
 */
export async function readPublicationPreparation(
  deps: PublicationDependencies,
  realmId: string,
  subjectId: string,
  context: PublicationReadContext,
) {
  if (!Number.isFinite(context.deadline)) throw new AccessUnavailableError('deadline');
  requireAccessDeadline(context.deadline);
  if (context.actor.kind !== 'account' || routeOf(realmId) === null || routeOf(subjectId) === null) return null;
  const actor = context.actor;
  const before = await observe(deps, realmId, subjectId, context, await realmChecks(deps, realmId, context));
  if (!before) return null;
  const subject = await preparePublicationSubject(deps, subjectId, context);
  if (!subject) return null;
  // No origin checkout is held while current Subject, label and Content media
  // observations run. Optional display failures do not change command advice.
  let subjectPresentations: SubjectPresentations = {
    original: unavailablePresentation(),
    terminal: unavailablePresentation(),
  };
  let summaryObservation: Awaited<ReturnType<typeof readSubjectSummaryObservation>> | undefined;
  try {
    const selectedIds = [...new Set([subject.originalId, subject.currentId])];
    summaryObservation = await readSubjectSummaryObservation(
      {
        pool: deps.pool,
        routeKey: deps.routeKey,
        access: deps.access,
        actor,
        deadline: context.deadline,
      },
      selectedIds,
      { languages: context.languages ?? [] },
    );
    subjectPresentations = projectPublicationPresentations(
      subject.originalId,
      subject.currentId,
      summaryObservation.summaries,
      summaryObservation.covers,
    );
  } catch {
    // A missing optional display dependency is explicit and carries no stale
    // label, media identifier, descriptor or rights metadata.
  }
  const checks = await realmChecks(deps, realmId, context, before.row.space_id);
  if (!(await subject.current())) throw new AccessUnavailableError('contention');
  if (summaryObservation && !(await summaryObservation.current())) throw new AccessUnavailableError('contention');
  const after = await observe(deps, realmId, subjectId, context, checks);
  if (!after) return null;
  if (!same(before, after)) throw new AccessUnavailableError('contention');
  requireAccessDeadline(context.deadline);
  return {
    preparation: boundedPreparation(
      response(realmId, subjectId, subject.currentId, after.row, actor, subjectPresentations),
    ),
    components: [after.component, ...subject.components, ...(summaryObservation?.components ?? [])],
  };
}
