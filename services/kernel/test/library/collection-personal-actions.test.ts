import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import {
  createListPresentationFixture,
  listRouteKey,
} from "../semantic/support/list-presentation-fixture.ts";
import { testTokens } from "../support/test-kernel.ts";
import { createCollectionReads } from "../../src/library/collection-reads.ts";
import { assertMemberPageCurrent } from "../../src/library/member-viewer-currentness.ts";
import { STANDARD_QUESTION_ID } from "../../src/rating/votes.ts";
import type { ViewerPersonalActionsReader } from "../../src/library/viewer-personal-actions.ts";

let f: Awaited<ReturnType<typeof createListPresentationFixture>>;
beforeAll(async () => {
  f = await createListPresentationFixture({ poolMax: 1 });
  await f.checked(
    "POST",
    "/v1/platform/exposure/collections:open",
    {},
    "operator",
  );
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function collection() {
  const subjectId = await f.create("schema:Book");
  const { collection } = await f.checked("POST", "/v1/collections", {
    title: "Personal actions",
    visibility: "public",
  });
  for (const note of ["first", "second"])
    await f.checked("POST", `/v1/collections/${collection.id}/members`, {
      subjectId,
      note,
    });
  return { id: collection.id as string, subjectId };
}

// Change native source after the retained helper has read its personal facts. The mounted route must refuse
// before Elysia serializes either the source or private projection, including when that projection is unavailable.
function interleave(mutate: () => Promise<unknown>) {
  const descriptor = Object.getOwnPropertyDescriptor(f.pool, "connect");
  const connect = f.pool.connect;
  let reads = 0;
  Object.defineProperty(f.pool, "connect", {
    configurable: true,
    value: async () => {
      const client = (await Reflect.apply(connect, f.pool, [])) as PoolClient;
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== "query")
            return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            const statement =
              typeof args[0] === "string"
                ? args[0]
                : String((args[0] as { text?: string })?.text);
            const result = await Reflect.apply(value, target, args);
            if (
              statement.includes('incarnation_id AS "incarnationId"') &&
              ++reads === 3
            )
              await mutate();
            return result;
          };
        },
      });
    },
  });
  return {
    reads: () => reads,
    restore() {
      if (descriptor) Object.defineProperty(f.pool, "connect", descriptor);
      else Reflect.deleteProperty(f.pool, "connect");
    },
  };
}

test("mounted FULL wire preserves duplicate original occurrences and independent native action state", async () => {
  const { id, subjectId } = await collection();
  const path = `/v1/collections/${id}/members`;
  const response = await f.call(
    "GET",
    `${path}?view=FULL`,
    undefined,
    "editor",
  );
  expect(response.status).toBe(200);
  const page = response.body as {
    members: Array<{ id: string; subjectId: string; note: string }>;
    viewerFacts: {
      state: string;
      rows: Array<{
        rowKey: string;
        subjectId: string;
        entry: unknown;
        vote: unknown;
        actions: unknown;
      }>;
    };
  };
  expect(page.members.map((m) => [m.subjectId, m.note])).toEqual([
    [subjectId, "first"],
    [subjectId, "second"],
  ]);
  expect(page.members[0]!.id).not.toBe(page.members[1]!.id);
  expect(page.viewerFacts.state).toBe("current");
  expect(page.viewerFacts.rows.map((r) => [r.rowKey, r.subjectId])).toEqual(
    page.members.map((m) => [m.id, m.subjectId]),
  );
  for (const row of page.viewerFacts.rows) {
    expect(row.entry).toEqual({ state: "absent" });
    expect(row.vote).toHaveProperty("state");
    expect(row.actions).toHaveProperty("state");
  }
  for (const [view, persona] of [
    ["BASIC", "editor"],
    ["FULL", "anonymous"],
  ] as const) {
    const basic = await f.call(
      "GET",
      `${path}?view=${view}`,
      undefined,
      persona,
    );
    expect(basic.status).toBe(200);
    expect(basic.body).not.toHaveProperty("viewerFacts");
  }
});

for (const field of ["visibility", "revision", "source_generation"] as const)
  test(`mounted final personal pass refuses changed ${field} before serialization`, async () => {
    const { id } = await collection();
    const value = field === "visibility" ? "'private'" : `${field}+1`;
    const hook = interleave(() =>
      f.db.admin.query(
        `UPDATE library.collection SET ${field}=${value} WHERE collection_id=$1`,
        [id],
      ),
    );
    let response;
    try {
      response = await f.call(
        "GET",
        `/v1/collections/${id}/members?view=FULL`,
        undefined,
        "editor",
      );
    } finally {
      hook.restore();
    }
    expect(hook.reads()).toBeGreaterThanOrEqual(3);
    expect([404, 409, 503]).toContain(response.status);
    expect(response.body).not.toHaveProperty("members");
    expect(response.body).not.toHaveProperty("viewerFacts");
  });

test("Collection composes exact raw operands and preserves empty allowed and typed unavailable actions", async () => {
  const { id, subjectId } = await collection();
  const response = await f.call(
    "GET",
    `/v1/collections/${id}/members`,
    undefined,
    "editor",
  );
  const page = response.body as {
    members: Array<{ id: string; subjectId: string }>;
    next: string | null;
  };
  const actor = {
    kind: "account" as const,
    accountId: f.accounts.editor,
    authnEpoch: 1,
    scopes: ["subject:read"],
  };
  let finalized = false;
  const viewerPersonalActions: ViewerPersonalActionsReader = async (
    viewer,
    rows,
    question,
    deadline,
  ) => {
    expect(viewer).toBe(actor);
    expect(question).toBe(STANDARD_QUESTION_ID);
    expect(deadline).toBeGreaterThan(Date.now());
    expect(rows).toEqual(
      page.members.map((m) => ({
        rowKey: m.id,
        subjectId,
        resourceType: "schema:Book",
      })),
    );
    return {
      state: "current",
      question: null,
      rows: rows.map((row, index) => ({
        rowKey: row.rowKey,
        subjectId: row.subjectId,
        entry: { state: "absent" },
        vote: { state: "unavailable", reason: "question" },
        actions:
          index === 0
            ? { state: "current", allowed: [] }
            : { state: "unavailable", reason: "dependency" },
      })),
    };
  };
  const reads = createCollectionReads({
    pool: f.pool,
    access: f.access,
    tokens: testTokens(),
    routeKey: listRouteKey,
    viewerPersonalActions,
  });
  const result = await reads.withViewerFacts(
    actor,
    page,
    Date.now() + 30_000,
    async () => {
      finalized = true;
      assertMemberPageCurrent(page, page);
    },
  );
  expect(finalized).toBe(true);
  expect(result).toHaveProperty("viewerFacts.rows.0.actions", {
    state: "current",
    allowed: [],
  });
  expect(result).toHaveProperty("viewerFacts.rows.1.actions", {
    state: "unavailable",
    reason: "dependency",
  });
  expect(result.members).toBe(page.members);
});
