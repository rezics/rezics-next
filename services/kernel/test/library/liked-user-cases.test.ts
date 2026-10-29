import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { fromPlainText } from "@rezics/document";
import type { HttpResponse } from "../../../../specs/semantic-driver.ts";
import { derivedId, newId, routeOf } from "../../src/route/route.ts";
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from "../support/released-discovery.ts";

// Native HTTP expectations only. No Content reader/source/epoch adapter is supplied here.
type Owner = "alice" | "bob" | "outsider";
type Descriptor = Record<string, unknown> & {
  id: string;
  builtin?: { kind: string };
};
let fixture: ReleasedDiscoveryFixture;
const changed = new Map<string, { owner: Owner; path: string }>();

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1 });
  // Only the shared fixture's actual governor opens the required personal families.
  await fixture.setup.openFeatures(["personal_library", "reading_progress"]);
}, 180_000);
afterEach(async () => {
  for (const [key, { owner, path }] of changed) {
    const response = await fixture.request(
      owner,
      "DELETE",
      path,
      undefined,
      discoveryKey(),
    );
    status(response, 204, "Native reaction cleanup");
    changed.delete(key);
  }
}, 120_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function status(response: HttpResponse, expected: number, operation: string) {
  expect(
    response.status,
    `${operation}: ${JSON.stringify(response.body)}`,
  ).toBe(expected);
}
function privateOutput(response: HttpResponse) {
  const cache = response.headers.get("cache-control");
  expect(cache).toContain("private");
  expect(cache).toContain("no-store");
}
function logicalId(owner: Owner, kind: "liked" | "everything") {
  const id = fixture.personas[owner].accountId;
  // Use the existing deterministic primitive; the production builtin helper still lacks 'liked'.
  return derivedId(
    id,
    JSON.stringify(["library.collection.builtin", 1, kind]),
    routeOf(id)!,
  );
}
async function collections(owner: Owner) {
  const response = await fixture.request(
    owner,
    "GET",
    `/v1/collections?curatorAccountId=${fixture.personas[owner].accountId}&limit=100`,
  );
  status(response, 200, "Owner Collection discovery");
  expect(Array.isArray(response.body.collections)).toBe(true);
  expect(response.body.next).toBeNull();
  return { response, items: response.body.collections as Descriptor[] };
}
function descriptor(value: Descriptor, owner: Owner) {
  expect(value).toMatchObject({
    id: logicalId(owner, "liked"),
    curatorAccountId: fixture.personas[owner].accountId,
    membershipKind: "dynamic",
    builtinKind: "liked",
    builtin: { kind: "liked" },
    visibility: "private",
  });
  expect(value.builtin).toEqual({ kind: "liked" });
  for (const field of ["memberCount", "createdAt", "updatedAt", "orderEpoch"])
    expect(value).not.toHaveProperty(field);
}
async function members(
  owner: Owner,
  kind: "liked" | "everything" = "liked",
  query = "limit=100",
) {
  const response = await fixture.request(
    owner,
    "GET",
    `/v1/collections/${logicalId(owner, kind)}/members?${query}`,
  );
  status(response, 200, `${kind} useful member page`);
  privateOutput(response);
  expect(Array.isArray(response.body.members)).toBe(true);
  const items = response.body.members as Record<string, unknown>[];
  for (const item of items) {
    expect(item.kind).toBe("dynamic");
    expect(typeof item.subjectId).toBe("string");
    for (const field of ["id", "memberId", "note", "ordinalKey", "addedAt"])
      expect(item).not.toHaveProperty(field);
  }
  return { response, ids: items.map((item) => item.subjectId as string) };
}
async function exactMembers(
  ids: string[],
  owner: Owner = "alice",
  kind: "liked" | "everything" = "liked",
) {
  const page = await members(owner, kind);
  expect(page.ids).toHaveLength(ids.length);
  expect([...page.ids].sort()).toEqual([...ids].sort());
  expect(page.response.body.next).toBeNull();
}
async function react(owner: Owner, path: string, kind: string | null) {
  const facts = await personalFacts(owner);
  const response = await fixture.request(
    owner,
    kind === null ? "DELETE" : "PUT",
    path,
    kind === null ? undefined : { kind },
    discoveryKey(),
  );
  status(
    response,
    kind === null ? 204 : 200,
    `Native current reaction ${path}`,
  );
  if (kind !== null) expect(response.body).toEqual({ kind });
  if (kind === null) changed.delete(`${owner}:${path}`);
  else changed.set(`${owner}:${path}`, { owner, path });
  expect(
    await personalFacts(owner),
    "Reactions must not write personal facts, pins or state support",
  ).toEqual(facts);
}
async function subjectReaction(owner: Owner, id: string, kind: string | null) {
  const path = `/v1/subjects/${id}/reaction`;
  await react(owner, path, kind);
  const current = await fixture.request(owner, "GET", path);
  status(current, 200, "Native own subject reaction");
  expect(current.body).toEqual({ kind });
}
async function noPresence(owner: Owner = "alice") {
  const { items } = await collections(owner);
  expect(
    items.filter((item) => item.builtin?.kind === "everything"),
  ).toHaveLength(1);
  expect(items.filter((item) => item.builtin?.kind === "state")).toHaveLength(
    0,
  );
  await exactMembers([], owner, "everything");
}
async function personalFacts(owner: Owner) {
  // Whole rows include actual accepted pins; inspection cannot create facts or authorize a reaction.
  return (
    await fixture.inspect(
      `SELECT 'entry' AS family, to_jsonb(r) AS value FROM library.entry r WHERE account_id = $1
       UNION ALL SELECT 'session', to_jsonb(r) FROM library.progress_session r WHERE account_id = $1
       UNION ALL SELECT 'holding', to_jsonb(r) FROM library.copy r WHERE account_id = $1
       UNION ALL SELECT 'label', to_jsonb(r) FROM library.label_assignment r WHERE account_id = $1
       UNION ALL SELECT 'state_reference', to_jsonb(r) FROM library.builtin_collection_reference r WHERE account_id = $1
       UNION ALL SELECT 'state_support', to_jsonb(r) FROM library.builtin_state_reference_source r WHERE account_id = $1
       UNION ALL SELECT 'state_sequence', to_jsonb(r) FROM library.owner_write_counter r WHERE account_id = $1
       ORDER BY family, value`,
      [fixture.personas[owner].accountId],
    )
  ).rows;
}
async function domainState() {
  // Derived preparation/cache and its work intent are permitted by the common members GET contract.
  // These native domain tables must stay unchanged even if members need that preparation.
  return (
    await fixture.inspect(
      `SELECT 'header' AS family, to_jsonb(r) AS value FROM library.collection r
       UNION ALL SELECT 'grant', to_jsonb(r) FROM access.resource_grant r
       UNION ALL SELECT 'role_grant', to_jsonb(r) FROM access.resource_role_grant r
       UNION ALL SELECT 'resource', to_jsonb(r) FROM access.resource_initialization r
       UNION ALL SELECT 'receipt', to_jsonb(r) FROM core.receipt r
       UNION ALL SELECT 'outbox', to_jsonb(r) FROM core.outbox r
       ORDER BY family, value`,
    )
  ).rows;
}
async function reactionSubject(type: string, name: string) {
  // setupContent installs native active-account standing on Global, never on the created subject.
  return fixture.createSubject(type, name);
}

test("every empty account discovers exactly one private dynamic Liked without changing Everything or state discovery", async () => {
  const ids = [];
  for (const owner of ["alice", "bob", "outsider"] as const) {
    const { response, items } = await collections(owner);
    const liked = items.filter((item) => item.builtin?.kind === "liked");
    expect(liked, "Missing native logical Liked descriptor").toHaveLength(1);
    privateOutput(response);
    descriptor(liked[0]!, owner);
    ids.push(liked[0]!.id);
    await noPresence(owner);
    await exactMembers([], owner);
  }
  expect(new Set(ids).size).toBe(3);
}, 120_000);

test("repeated owner Liked point and member GETs return stable logical identity and empty final pages", async () => {
  let first: Record<string, unknown> | undefined;
  for (let read = 0; read < 3; read++) {
    const response = await fixture.request(
      "alice",
      "GET",
      `/v1/collections/${logicalId("alice", "liked")}`,
    );
    status(response, 200, "Missing native headerless Liked point reader");
    privateOutput(response);
    descriptor(response.body.collection as Descriptor, "alice");
    expect((response.body.collection as Descriptor).revision).toBe(0);
    if (first) expect(response.body).toEqual(first);
    first = response.body;
    await exactMembers([]);
  }
}, 120_000);

test("discovery point and repeated empty members GETs preserve native headers grants receipts and outbox", async () => {
  expect(
    (
      await fixture.inspect<{ read_only: string }>(
        "SELECT current_setting('transaction_read_only') AS read_only",
      )
    ).rows,
  ).toEqual([{ read_only: "on" }]);
  const before = await domainState();
  const responses: HttpResponse[] = [];
  for (const owner of ["alice", "bob", "outsider"] as const) {
    for (let read = 0; read < 3; read++) {
      for (const path of [
        `/v1/collections?curatorAccountId=${fixture.personas[owner].accountId}&limit=100`,
        `/v1/collections/${logicalId(owner, "liked")}`,
        `/v1/collections/${logicalId(owner, "liked")}/members?limit=100`,
      ])
        responses.push(await fixture.request(owner, "GET", path));
    }
  }
  expect(
    await domainState(),
    "GET must not materialize or mutate domain state",
  ).toEqual(before);
  // These genuinely empty direct cases require final 200 pages; no preparation is forced by the test.
  for (const response of responses)
    status(response, 200, "Empty logical Liked native read");
}, 120_000);

test("ordinary Alice Bob and outsider react through native Global standing without per-subject grants or personal facts", async () => {
  const subject = await reactionSubject(
    "schema:Book",
    "Ordinary subject reaction prerequisite",
  );
  for (const owner of ["alice", "bob", "outsider"] as const) {
    expect(await personalFacts(owner)).toEqual([]);
    const grants = await fixture.inspect(
      `SELECT * FROM access.resource_grant
       WHERE subject_id = $1 AND (resource_id = $2 OR action = 'reaction:set')`,
      [fixture.personas[owner].accountId, subject.id],
    );
    expect(grants.rows).toEqual([]);
    await subjectReaction(owner, subject.id, "like");
    await subjectReaction(owner, subject.id, "love");
    await subjectReaction(owner, subject.id, null);
    expect(await personalFacts(owner)).toEqual([]);
  }
}, 120_000);

for (const kind of ["like", "love"] as const)
  test(`owner current subject ${kind} yields exactly one Liked member and no Everything or state`, async () => {
    const subject = await reactionSubject("schema:Book", `Liked ${kind}`);
    await subjectReaction("alice", subject.id, kind);
    await exactMembers([subject.id]);
    await noPresence();
    await subjectReaction("alice", subject.id, null);
    await exactMembers([]);
    await noPresence();
  }, 120_000);

test("like to love replacement preserves one member and clearing the last qualifying subject reaction removes it immediately", async () => {
  const subject = await reactionSubject(
    "schema:Book",
    "Replace qualifying reaction",
  );
  await subjectReaction("alice", subject.id, "like");
  await exactMembers([subject.id]);
  await subjectReaction("alice", subject.id, "love");
  await exactMembers([subject.id]);
  await subjectReaction("alice", subject.id, null);
  await exactMembers([]);
}, 120_000);

test("clearing one liked target preserves the other current love member until its own last reaction clears", async () => {
  const first = await reactionSubject("schema:Book", "First qualifying target");
  const second = await reactionSubject(
    "schema:Book",
    "Remaining qualifying target",
  );
  await subjectReaction("alice", first.id, "like");
  await subjectReaction("alice", second.id, "love");
  await exactMembers([first.id, second.id]);
  await subjectReaction("alice", first.id, null);
  await exactMembers([second.id]);
  await subjectReaction("alice", second.id, null);
  await exactMembers([]);
}, 120_000);

for (const kind of ["laugh", "insightful", "sad"] as const)
  test(`current subject ${kind} cannot establish Liked and replacing a like with it removes membership`, async () => {
    const subject = await reactionSubject(
      "schema:Book",
      `Nonqualifying ${kind}`,
    );
    await subjectReaction("alice", subject.id, kind);
    await exactMembers([]);
    await subjectReaction("alice", subject.id, "like");
    await exactMembers([subject.id]);
    await subjectReaction("alice", subject.id, kind);
    await exactMembers([]);
    await noPresence();
  }, 120_000);

test("Bob subject reactions remain separate from Alice Liked even on the same readable subject", async () => {
  const subject = await reactionSubject(
    "schema:Book",
    "Independent reacting owners",
  );
  await subjectReaction("bob", subject.id, "love");
  await exactMembers([], "alice");
  await exactMembers([subject.id], "bob");
  await subjectReaction("alice", subject.id, "like");
  await exactMembers([subject.id], "alice");
  await subjectReaction("alice", subject.id, null);
  await exactMembers([], "alice");
  await exactMembers([subject.id], "bob");
  await noPresence("alice");
  await noPresence("bob");
}, 120_000);

test("a readable unprofiled subject accepts an owner like without a synthetic profile or default state", async () => {
  expect(
    fixture.release.definition.types["skos:Concept"]!.library,
  ).toBeUndefined();
  const subject = await reactionSubject(
    "skos:Concept",
    "Unprofiled liked concept",
  );
  status(
    await fixture.read(subject, "alice"),
    200,
    "Actual readable unprofiled subject",
  );
  await subjectReaction("alice", subject.id, "like");
  await exactMembers([subject.id]);
  await noPresence();
}, 120_000);

test("subject reactions create no native entry session holding or state sibling", async () => {
  const subject = await reactionSubject(
    "schema:Book",
    "Reaction without personal support",
  );
  const paths = [
    ["/v1/libraryEntries?limit=100", "libraryEntries"],
    [
      `/v1/progressSessions?subjectId=${subject.id}&limit=100`,
      "progressSessions",
    ],
    [`/v1/copies?subjectId=${subject.id}&limit=100`, "copies"],
  ] as const;
  const inspect = async () => {
    const bodies = [];
    for (const [path, field] of paths) {
      const response = await fixture.request("alice", "GET", path);
      status(
        response,
        200,
        `Native fixture prerequisite: required personal family must be open: ${path}`,
      );
      expect(response.body[field]).toEqual([]);
      expect(response.body.next).toBeNull();
      bodies.push(response.body);
    }
    return bodies;
  };
  const before = await inspect();
  await subjectReaction("alice", subject.id, "love");
  expect(await inspect()).toEqual(before);
  await noPresence();
}, 120_000);

test("thread and post like or love reactions referencing a subject do not qualify for Liked", async () => {
  const subject = await fixture.createSubject(
    "schema:Book",
    "Discussion reaction control",
  );
  // Space creation is privileged separately from exposure; use only the shared named-persona setup.
  await fixture.setup.spaceCreation("alice");
  await fixture.setup.realmCreation("alice");
  const space = await fixture.request(
    "alice",
    "POST",
    "/v1/spaces",
    { title: "Liked controls" },
    discoveryKey(),
  );
  status(space, 201, "Native fixture prerequisite: real Space creation");
  const context = await fixture.request(
    "editor",
    "POST",
    "/v1/contexts",
    { labels: { en: "Liked discussion control" } },
    discoveryKey(),
  );
  status(
    context,
    201,
    "Native fixture prerequisite: real community Context creation",
  );
  const realm = await fixture.request(
    "alice",
    "POST",
    "/v1/realms",
    {
      spaceId: (space.body.space as { spaceId: string }).spaceId,
      title: "Liked controls",
      visibility: "public",
      contextId: (context.body.context as { id: string }).id,
    },
    discoveryKey(),
  );
  status(realm, 201, "Native fixture prerequisite: real Realm creation");
  const realmId = (realm.body.realm as { realmId: string }).realmId;
  const scheme = await fixture.createSubject(
    "skos:ConceptScheme",
    "Reaction control board scheme",
  );
  const concept = await fixture.createSubject(
    "skos:Concept",
    "Reaction control board",
  );
  await fixture.adopt(concept, discoveryStatement("skos:inScheme", scheme.id));
  const etag = realm.headers.get("etag");
  expect(typeof etag).toBe("string");
  const selected = await fixture.request(
    "alice",
    "PUT",
    `/v1/realms/${realmId}/boardScheme`,
    { schemeId: scheme.id },
    { ...discoveryKey(), "If-Match": etag! },
  );
  status(
    selected,
    200,
    "Native fixture prerequisite: real board scheme selection",
  );
  const board = await fixture.request(
    "alice",
    "POST",
    `/v1/realms/${realmId}/boards`,
    {
      conceptId: concept.id,
      title: "Reaction controls",
      visibility: "published",
    },
    discoveryKey(),
  );
  status(board, 201, "Native fixture prerequisite: real board creation");
  const created = await fixture.request(
    "alice",
    "POST",
    "/v1/threads",
    {
      title: "Discussion about a subject",
      body: fromPlainText("A thread reaction is not a subject reaction."),
      licence: "CC-BY-4.0",
      subjectIds: [subject.id],
      boardId: (board.body.board as { id: string }).id,
      visibility: "published",
    },
    discoveryKey(),
  );
  status(
    created,
    201,
    "Native fixture prerequisite: real thread and first post creation",
  );
  const thread = created.body.thread as {
    id: string;
    firstPost: { id: string };
  };
  await react("alice", `/v1/threads/${thread.id}/reaction`, "like");
  await react("alice", `/v1/posts/${thread.firstPost.id}/reaction`, "love");
  await exactMembers([]);
  const own = await fixture.request(
    "alice",
    "GET",
    `/v1/subjects/${subject.id}/reaction`,
  );
  status(own, 200, "No subject reaction created by thread or post reaction");
  expect(own.body).toEqual({ kind: null });
  await noPresence();
}, 120_000);

test("Liked uses useful common signed member pages and reauthorizes a continuation with the real suspended pretoken", async () => {
  const subjects = [];
  for (let index = 0; index < 3; index++) {
    const subject = await reactionSubject(
      "schema:Book",
      `Paged liked subject ${index}`,
    );
    subjects.push(subject.id);
    await subjectReaction("alice", subject.id, index === 1 ? "love" : "like");
  }
  const first = await members("alice", "liked", "limit=2");
  expect(first.ids).toEqual([...subjects].sort().slice(0, 2));
  const next = first.response.body.next;
  expect(typeof next).toBe("string");
  expect(next).not.toBe("");
  for (const id of subjects) expect(next as string).not.toContain(id);
  const query = `limit=2&cursor=${encodeURIComponent(next as string)}`;
  const last = await members("alice", "liked", query);
  expect(last.ids).toEqual([...subjects].sort().slice(2));
  expect(last.response.body.next).toBeNull();
  const token = next as string;
  const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
  const invalid = await fixture.request(
    "alice",
    "GET",
    `/v1/collections/${logicalId("alice", "liked")}/members?limit=2&cursor=${encodeURIComponent(tampered)}`,
  );
  status(invalid, 400, "Common cursor authentication rejects tampering");
  expect(invalid.body.code).toBe("invalid_cursor");
  const revoked = await fixture.request(
    "suspended",
    "GET",
    `/v1/collections/${logicalId("alice", "liked")}/members?${query}`,
  );
  invalidCredentials(revoked);
}, 120_000);

function invalidCredentials(response: HttpResponse) {
  status(response, 401, "Native pre-suspension bearer is revoked");
  expect(response.body).toMatchObject({
    status: 401,
    code: "invalid_credentials",
  });
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer error="invalid_token"',
  );
}

test("other and anonymous Liked point and members reads conceal identity exactly like unknown Collections", async () => {
  const unknown = newId(routeOf(fixture.personas.alice.accountId)!);
  for (const viewer of [
    "bob",
    "anonymous",
  ] as const satisfies readonly DiscoveryPersona[]) {
    const discovery = await fixture.request(
      viewer,
      "GET",
      `/v1/collections?curatorAccountId=${fixture.personas.alice.accountId}&limit=100`,
    );
    status(discovery, 200, "Other-viewer Collection discovery");
    expect(
      (discovery.body.collections as Descriptor[]).map((item) => item.id),
    ).not.toContain(logicalId("alice", "liked"));
    for (const suffix of ["", "/members"]) {
      const hidden = await fixture.request(
        viewer,
        "GET",
        `/v1/collections/${logicalId("alice", "liked")}${suffix}`,
      );
      const missing = await fixture.request(
        viewer,
        "GET",
        `/v1/collections/${unknown}${suffix}`,
      );
      status(hidden, 404, "Private Liked concealment");
      status(missing, 404, "Unknown Collection control");
      expect(hidden.body).toMatchObject({ status: 404, code: "not_found" });
      const { request_id: hiddenRequest, ...hiddenProblem } = hidden.body;
      const { request_id: missingRequest, ...missingProblem } = missing.body;
      expect(typeof hiddenRequest).toBe("string");
      expect(typeof missingRequest).toBe("string");
      expect(hiddenProblem).toEqual(missingProblem);
      expect(hidden.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    }
  }
}, 120_000);

test("native suspension rejects its pre-existing token on Liked point and members without inventing a valid suspended actor", async () => {
  for (const suffix of ["", "/members"])
    invalidCredentials(
      await fixture.request(
        "suspended",
        "GET",
        `/v1/collections/${logicalId("alice", "liked")}${suffix}`,
      ),
    );
}, 120_000);
