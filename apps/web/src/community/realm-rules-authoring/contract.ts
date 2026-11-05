import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import * as v from 'valibot';

const id = v.pipe(v.string(), v.uuid());
const reference = v.strictObject({ postId: id, revisionId: id });
const action = v.strictObject({ state: v.picklist(['allowed', 'denied', 'unavailable', 'stale']) });
const destination = v.strictObject({
  boardId: id,
  title: v.nullable(v.pipe(v.string(), v.maxLength(1024))),
  create: action,
});

const current = v.variant('state', [
  v.strictObject({ state: v.literal('none'), reference: v.null() }),
  v.strictObject({
    state: v.literal('available'),
    reference,
    title: v.nullable(v.pipe(v.string(), v.maxLength(1024))),
    authorId: id,
    threadId: id,
    boardId: id,
    boardTitle: v.nullable(v.pipe(v.string(), v.maxLength(1024))),
    mediaIds: v.pipe(v.array(id), v.maxLength(32)),
    body: v.unknown(),
    language: v.nullable(v.pipe(v.string(), v.maxLength(128))),
    licence: v.pipe(v.string(), v.maxLength(256)),
    sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
    currentRevision: v.boolean(),
  }),
  v.strictObject({ state: v.literal('erased'), reference }),
  v.strictObject({ state: v.literal('concealed'), reference }),
  v.strictObject({ state: v.literal('unavailable'), reference: v.nullable(reference) }),
]);

export const rulesAuthoringResponseSchema = v.strictObject({
  realm: v.strictObject({ realmId: id, head: id }),
  current,
  destinations: v.variant('state', [
    v.strictObject({
      state: v.literal('available'),
      items: v.pipe(v.array(destination), v.maxLength(20)),
      next: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
    }),
    v.strictObject({ state: v.literal('denied'), items: v.pipe(v.array(v.never()), v.maxLength(0)), next: v.null() }),
    v.strictObject({
      state: v.literal('unavailable'),
      items: v.pipe(v.array(v.never()), v.maxLength(0)),
      next: v.null(),
    }),
  ]),
  actions: v.strictObject({ attach: action, create: action, edit: action }),
});

export type RulesAuthoringResponse = Omit<v.InferOutput<typeof rulesAuthoringResponseSchema>, 'current'> & {
  current:
    | { state: 'none'; reference: null }
    | {
        state: 'available';
        reference: { postId: string; revisionId: string };
        title: string | null;
        authorId: string;
        threadId: string;
        boardId: string;
        boardTitle: string | null;
        mediaIds: readonly string[];
        body: DocumentSnapshot;
        language: string | null;
        licence: string;
        sha256: string;
        currentRevision: boolean;
      }
    | { state: 'erased' | 'concealed'; reference: { postId: string; revisionId: string } }
    | { state: 'unavailable'; reference: { postId: string; revisionId: string } | null };
};
export type RulesAuthoringRead =
  | { kind: 'ready'; value: RulesAuthoringResponse }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export function parseRulesAuthoringResponse(value: unknown): RulesAuthoringResponse {
  const result = v.parse(rulesAuthoringResponseSchema, value);
  if (result.current.state === 'available' && !checkDocument(result.current.body))
    throw new TypeError('Invalid native rules document');
  return result as RulesAuthoringResponse;
}
