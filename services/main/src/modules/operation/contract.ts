import { t } from 'elysia';

export const operationResult = t.Object({
  operationId: t.String(),
  status: t.Union([
    t.Literal('accepted'),
    t.Literal('completed'),
    t.Literal('partial'),
    t.Literal('cancelled'),
  ]),
  items: t.Array(
    t.Object({
      ordinal: t.Integer(),
      target: t.String(),
      state: t.Union([
        t.Literal('confirmed'),
        t.Literal('pending'),
        t.Literal('uncertain'),
        t.Literal('failed'),
      ]),
      receipt: t.Nullable(t.String()),
      continuation: t.Nullable(t.String()),
      error: t.Nullable(t.String()),
    }),
  ),
  continuation: t.Nullable(t.String()),
});
