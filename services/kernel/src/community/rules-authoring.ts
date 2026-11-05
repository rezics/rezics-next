import { memoizedValue } from '../memoized.ts';
import { DocumentSnapshotSchema, type DocumentSnapshot } from '@rezics/document';
import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Actor } from '../request/access.ts';
import {
  readExactPublishedRulesForAuthoring,
  readBoardPageActionEvidence,
  ContentNotFoundError,
} from '../content/reads.ts';
import { listRealmBoards } from '../content/boards.ts';
import type { ReadContext } from '../content/model.ts';
import { readRealmSettingsPage, type RealmSettingsPage } from './settings-page.ts';
import type { RealmDependencies } from './realm.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const reference = t.Object({ postId: id, revisionId: id }, closed);
const actionState = t.Union([
  t.Object({ state: t.Literal('allowed') }, closed),
  t.Object({ state: t.Literal('denied') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
  t.Object({ state: t.Literal('stale') }, closed),
]);

export const RulesAuthoringQuerySchema = t.Object(
  { cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })) },
  closed,
);

export function RulesAuthoringPageSchema() {
  return memoizedValue(RulesAuthoringPageSchema, () =>
    t.Object(
      {
        realm: t.Object({ realmId: id, head: id }, closed),
        current: t.Union([
          t.Object({ state: t.Literal('none'), reference: t.Null() }, closed),
          t.Object(
            {
              state: t.Literal('available'),
              reference,
              title: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
              authorId: id,
              threadId: id,
              boardId: id,
              boardTitle: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
              mediaIds: t.Array(id, { maxItems: 32 }),
              body: DocumentSnapshotSchema,
              language: t.Union([t.String({ maxLength: 128 }), t.Null()]),
              licence: t.String({ maxLength: 256 }),
              sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
              currentRevision: t.Boolean(),
            },
            closed,
          ),
          t.Object({ state: t.Literal('erased'), reference }, closed),
          t.Object({ state: t.Literal('concealed'), reference }, closed),
          t.Object({ state: t.Literal('unavailable'), reference: t.Union([reference, t.Null()]) }, closed),
        ]),
        destinations: t.Union([
          t.Object(
            {
              state: t.Literal('available'),
              items: t.Array(
                t.Object(
                  { boardId: id, title: t.Union([t.String({ maxLength: 1024 }), t.Null()]), create: actionState },
                  closed,
                ),
                { maxItems: 20 },
              ),
              next: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
            },
            closed,
          ),
          t.Object({ state: t.Literal('denied'), items: t.Array(t.Never(), { maxItems: 0 }), next: t.Null() }, closed),
          t.Object(
            { state: t.Literal('unavailable'), items: t.Array(t.Never(), { maxItems: 0 }), next: t.Null() },
            closed,
          ),
        ]),
        actions: t.Object({ attach: actionState, create: actionState, edit: actionState }, closed),
      },
      closed,
    ),
  );
}
export type RulesAuthoringPage = Static<ReturnType<typeof RulesAuthoringPageSchema>>;
export type RulesAuthoringDependencies = Pick<RealmDependencies, 'pool' | 'access' | 'clock'> & {
  tokens: import('../tokens/seal.ts').KeyRing;
};

function languageOf(body: DocumentSnapshot): string | null {
  for (const node of body.doc.content ?? []) {
    const language = node.attrs?.lang;
    if (typeof language === 'string') return language;
  }
  return null;
}

function action(state: 'allowed' | 'denied' | 'unavailable' | 'stale') {
  return { state } as const;
}

export async function readRealmRulesAuthoringPage(
  deps: RulesAuthoringDependencies,
  actor: Actor,
  realmId: string,
  context: ReadContext,
  input: Static<typeof RulesAuthoringQuerySchema> = {},
): Promise<RulesAuthoringPage> {
  const initial = await readRealmSettingsPage(deps, actor, realmId, {
    deadline: context.deadline,
  });
  const referenceValue = initial.snapshot.presentation.rules;

  let destinations: RulesAuthoringPage['destinations'];
  try {
    const page = await listRealmBoards({ ...deps, tokens: deps.tokens }, realmId, context, {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: 20,
    });
    const candidates = page.items.filter(
      (board) => board.purpose === 'discussion' && board.availability === 'available',
    );
    const items = await Promise.all(
      candidates.map(async (board) => {
        try {
          const evidence = await readBoardPageActionEvidence(deps, board.id, board, [], context);
          return {
            boardId: board.id,
            title: board.title,
            create: action(evidence.createThread ? 'allowed' : 'denied'),
          };
        } catch (error) {
          return {
            boardId: board.id,
            title: board.title,
            create: action(error instanceof ContentNotFoundError ? 'stale' : 'unavailable'),
          };
        }
      }),
    );
    destinations = { state: 'available', items, next: page.next };
  } catch (error) {
    destinations =
      error instanceof ContentNotFoundError
        ? { state: 'denied', items: [], next: null }
        : { state: 'unavailable', items: [], next: null };
  }
  const settings: RealmSettingsPage = await readRealmSettingsPage(deps, actor, realmId, {
    deadline: context.deadline,
  });
  const sameReference =
    settings.snapshot.presentation.rules?.postId === referenceValue?.postId &&
    settings.snapshot.presentation.rules?.revisionId === referenceValue?.revisionId;
  let current: RulesAuthoringPage['current'] = { state: 'none', reference: null };
  let edit = action('denied');
  if (!sameReference) {
    const latestReference = settings.snapshot.presentation.rules;
    current = {
      state: 'unavailable',
      reference: latestReference ? { postId: latestReference.postId, revisionId: latestReference.revisionId } : null,
    };
    edit = action('unavailable');
  } else if (referenceValue) {
    const referenceKey = { postId: referenceValue.postId, revisionId: referenceValue.revisionId };
    try {
      const details = await readExactPublishedRulesForAuthoring(deps, [{ ...referenceKey, realmId }], context);
      const item = details.get(`${realmId}/${referenceKey.postId}/${referenceKey.revisionId}`);
      if (item?.state === 'available') {
        current = {
          state: 'available',
          reference: referenceKey,
          title: item.title,
          authorId: item.authorId,
          threadId: item.threadId,
          boardId: item.boardId,
          boardTitle: item.boardTitle,
          mediaIds: [...item.mediaIds],
          body: item.rules.body,
          language: languageOf(item.rules.body),
          licence: item.rules.licence,
          sha256: item.rules.sha256,
          currentRevision: item.currentRevision,
        };
        edit = item.currentRevision ? action(item.revisionAction) : action('stale');
      } else if (item?.state === 'erased') {
        current = { state: 'erased', reference: referenceKey };
        edit = action('denied');
      } else if (!item || item.state === 'concealed') {
        current = { state: 'concealed', reference: referenceKey };
        edit = action('denied');
      }
    } catch {
      current = { state: 'unavailable', reference: referenceKey };
      edit = action('unavailable');
    }
  }
  const attach = settings.operations.update.available ? action('allowed') : action('denied');
  const create =
    destinations.state !== 'available'
      ? action(destinations.state)
      : destinations.items.some((item) => item.create.state === 'allowed')
        ? action('allowed')
        : destinations.items.some((item) => item.create.state === 'unavailable')
          ? action('unavailable')
          : destinations.items.some((item) => item.create.state === 'stale')
            ? action('stale')
            : action('denied');

  return {
    realm: { realmId, head: settings.snapshot.head },
    current,
    destinations,
    actions: { attach, create, edit },
  } as RulesAuthoringPage;
}
