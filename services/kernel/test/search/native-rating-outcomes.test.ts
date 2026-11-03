import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  HttpResponse,
  Persona,
  SearchDriver,
} from "../../../../specs/search-driver.ts";
import {
  createDriverClient,
  type DriverClient,
} from "./support/driver-client.ts";

// Executable specification, not a production receipt. Run natively only after the
// complete projection, current disclosure and default source/composition receipts.
// No direct SQL, figure drain, index writes or replacement default registrations.
const question = "00000000-0000-7000-8000-000000000001";
type Subject = { id: string; label: string };
type Page = { subjects: { id: string }[]; next: string | null; as_of: string };
type Indexed = {
  _id: string;
  _index: string;
  _source: {
    rating_score?: number | null;
    rating_prior_epoch?: number | null;
    name_sort: string | null;
  };
};

function problem(response: HttpResponse, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  expect(response.body).toMatchObject({
    status,
    code,
    request_id: expect.any(String),
  });
}
function page(response: HttpResponse): Page {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  // Adopted transport omits public aggregates, even when every hit is disclosed.
  // This does not prove internal unique-disclosed accounting or query cost.
  for (const key of [
    "total",
    "count",
    "counts",
    "lower_bound",
    "exact",
    "estimate",
  ])
    expect(response.body).not.toHaveProperty(key);
  const result = response.body as unknown as Page;
  expect(result.subjects).toBeArray();
  expect(new Set(result.subjects.map((hit) => hit.id)).size).toBe(
    result.subjects.length,
  );
  expect(
    result.next === null ||
      (typeof result.next === "string" && result.next.length > 0),
  ).toBe(true);
  expect(Number.isFinite(Date.parse(result.as_of))).toBe(true);
  return result;
}
async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
) {
  let last: T | undefined;
  // Real elapsed time and at most 240 reads; no accelerated schedules or manual drain.
  for (let attempt = 0; attempt < 240; attempt++) {
    last = await read();
    if (ready(last)) return last;
    await Bun.sleep(250);
  }
  throw new Error(
    `Native projection/API did not converge: ${JSON.stringify(last)}`,
  );
}
async function create(
  driver: SearchDriver,
  text: string,
  label: string,
): Promise<Subject> {
  const response = await driver.request(
    "editor",
    "POST",
    "/v1/subjects",
    { type: "schema:Book", labels: { en: label }, descriptions: { en: text } },
    { "Idempotency-Key": `"${randomUUID()}"` },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.headers.get("rezics-session-token")).toBeTruthy();
  return { id: (response.body.subject as { id: string }).id, label };
}
async function vote(
  client: DriverClient,
  voter: string,
  subject: Subject,
  units: number | null,
) {
  const response = await client.nativeVote(voter, subject.id, units);
  expect(response.status, JSON.stringify(response.body)).toBe(
    units === null ? 204 : 200,
  );
  if (units !== null) {
    expect(response.body).toEqual({
      units,
      revision: expect.any(Number),
      at: expect.any(String),
    });
    expect(response.headers.get("rezics-session-token")).toBeTruthy();
  }
}
async function aggregate(
  driver: SearchDriver,
  subject: Subject,
  count: number,
) {
  return eventually(
    async () => {
      const response = await driver.request(
        "anonymous",
        "GET",
        `/v1/subjects/${subject.id}/ratings?question=${question}&population=${driver.globalContext}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ question, subject: subject.id });
      return (response.body.figures as Record<string, unknown>[])[0]!;
    },
    (value) =>
      value.count === count &&
      (value.freshness as { updating: boolean }).updating === false,
  );
}
function nameOrder(subjects: Subject[]) {
  return [...subjects].sort((a, b) => {
    const left = a.label.toLowerCase();
    const right = b.label.toLowerCase();
    return left < right
      ? -1
      : left > right
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
}

// Five reusable, independently authenticated voters; 21 legal subjects; at most
// 100 simultaneously counted votes and 170 actual PUT/DELETE commands. Growth
// evidence for bounded raw candidates/source reads belongs to the native suites.
test("real native votes publish Global scores through the default worker, relay and Search with current disclosure", async () => {
  const client = createDriverClient();
  try {
    const driver = await client.init(); // Missing runtime rejects, never skip or fake success.
    const stats = (await client.inspect()).workerStats!;
    expect(stats.registeredModules).toEqual(stats.defaultModules);
    for (const name of stats.defaultModules)
      expect(stats.registrationCounts[name]).toBe(1);
    expect(stats.defaultModules).toContain("rating");
    for (const name of ["semantic", "search"])
      expect(stats.startedServices[name]).toBeGreaterThan(0);
    expect(stats.searchStarterInvocations).toBe(1);
    const text = `nativerating${randomUUID().replaceAll("-", "").replace(/[0-9]/g, "a")}`;
    const query = {
      text,
      filter: { type: { in: ["schema:Book"] } },
      sort: "rating",
      limit: 2,
    };
    const search = (
      extra: Record<string, unknown> = {},
      persona: Persona = "anonymous",
    ) =>
      driver.request(persona, "POST", "/v1/subjects:search", {
        ...query,
        ...extra,
      });
    const base: Subject[] = [];
    for (const label of [
      "Zulu tie",
      "Zulu tie",
      "Middle",
      "Zero",
      "Zero",
      "Zero b",
      "Zero c",
      "Zero d",
      "Zero e",
      "Zero f",
    ])
      base.push(await create(driver, text, label));
    // Lexically first but unscored: zero must precede this subject in rating order.
    const unrated = await create(driver, text, "A unrated");
    const voters = [];
    for (let i = 0; i < 5; i++)
      voters.push(await client.nativeVoter(`reader_${i}`));
    expect(new Set(voters.map((value) => value.accountId)).size).toBe(5);

    const owned = client
      .ledger()
      .resources.find((resource) => resource.kind === "index_prefix");
    if (!owned || owned.kind !== "index_prefix")
      throw new Error("Missing owned native index prefix");
    async function indexed(subjects: Subject[]): Promise<Indexed[]> {
      // Read-only observation of actual projected scores, never supplied hits or truth.
      const response = await fetch(
        `${process.env.OPENSEARCH_URL}/${owned!.name}subjects/_search`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            size: 25,
            query: { terms: { id: subjects.map((subject) => subject.id) } },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        timed_out: boolean;
        _shards: { failed: number };
        hits: { hits: Indexed[] };
      };
      expect(result.timed_out).toBe(false);
      expect(result._shards.failed).toBe(0);
      return result.hits.hits;
    }
    async function scores(
      subjects: Subject[],
      expected: (number | null)[],
      previousEpoch?: number,
    ) {
      const hits = await eventually(
        () => indexed(subjects),
        (hits) =>
          subjects.every((subject, index) => {
            const hit = hits.find((hit) => hit._id === subject.id);
            return (
              hit !== undefined &&
              (hit._source.rating_score ?? null) === expected[index] &&
              (expected[index] === null ||
                (Number.isSafeInteger(hit._source.rating_prior_epoch) &&
                  hit._source.rating_prior_epoch! > (previousEpoch ?? 0)))
            );
          }),
      );
      for (const [index, subject] of subjects.entries()) {
        const hit = hits.find((hit) => hit._id === subject.id)!;
        expect(hit._source.rating_score ?? null).toBe(expected[index]!);
        // No Realm/question-selectable data is admitted into the public document.
        expect(
          Object.keys(hit._source).filter((key) =>
            /realm|private|population|question/.test(key),
          ),
        ).toEqual([]);
      }
      return hits;
    }
    async function traverse(
      expected: Subject[],
      persona: Persona = "anonymous",
    ) {
      let cursor: string | null = null;
      let first: string | undefined;
      const seen: string[] = [];
      for (let offset = 0; offset < expected.length; offset += 2) {
        const result = page(
          await search(cursor === null ? {} : { cursor }, persona),
        );
        expect(result.subjects.map((hit) => hit.id)).toEqual(
          expected.slice(offset, offset + 2).map((subject) => subject.id),
        );
        seen.push(...result.subjects.map((hit) => hit.id));
        cursor = result.next;
        if (offset + 2 < expected.length) expect(cursor).toBeString();
        first ??= cursor ?? undefined;
      }
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(expected.length);
      return first!;
    }
    async function restart(cursor: string) {
      problem(await search({ cursor }), 409, "search_restart_required");
      const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
      problem(await search({ cursor: tampered }), 400, "invalid_request");
    }

    // A genuinely absent capability is typed unavailable, never a successful empty
    // search. Do not inject its absence; the complete runtime must become ready.
    await eventually(
      async () => {
        const response = await search();
        if (response.status === 503) problem(response, 503, "index_not_ready");
        else page(response);
        return response;
      },
      (response) => response.status === 200,
    );
    for (const persona of ["anonymous", "editor"] as const) {
      for (const [key, value] of [
        ["question", question],
        ["populationId", driver.globalContext],
        ["questionId", question],
      ] as const) {
        const response = await search({ [key]: value }, persona);
        problem(response, 400, "invalid_request");
        expect(response.body.errors).toContainEqual({
          pointer: `/${key}`,
          code: "unknown_field",
        });
      }
    }
    // The native persona bearer predates suspension, so the authentication floor rejects it.
    const suspended = await search({}, "suspended");
    problem(suspended, 401, "invalid_credentials");
    expect(suspended.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"',
    );

    // Freeze an exact m=0, C=5 prior at fifty genuine counted answers. Every
    // asynchronous apply has a real source event; reuse voters across subjects.
    for (const subject of base)
      for (const voter of voters) await vote(client, voter.voter, subject, 0);
    for (const subject of base)
      expect((await aggregate(driver, subject, 5)).mean).toBe(0);
    const initial = await scores(
      [...base, unrated],
      [...base.map(() => 0), null],
    );
    const epoch = initial.find((hit) => hit._id === base[0]!.id)!._source
      .rating_prior_epoch!;
    await driver.indexing("paused");
    await traverse([...nameOrder(base), unrated]);
    await driver.indexing("running");

    for (const [index, units] of [20, 20, 10].entries())
      for (const voter of voters)
        await vote(client, voter.voter, base[index]!, units);
    // Display units are half stored units: (5*0+50)/(5+5)=5.
    const expectedScores = [5, 5, 2.5, ...base.slice(3).map(() => 0)];
    const stable = await scores(base, expectedScores);
    expect(
      new Set(stable.map((hit) => hit._source.rating_prior_epoch)),
    ).toEqual(new Set([epoch]));
    const expected = [
      ...nameOrder(base.slice(0, 2)),
      base[2]!,
      ...nameOrder(base.slice(3)),
      unrated,
    ];
    await driver.indexing("paused");
    const old = await traverse(expected);
    await traverse(expected, "editor");
    await driver.indexing("running");

    // Doubling actual population count to 100 starts a new frozen m=6.25.
    // No snapshot is advanced by inventing a vote or calling the drain directly.
    const growth: Subject[] = [];
    for (let i = 0; i < 10; i++) {
      const subject = await create(
        driver,
        text,
        `Growth ${String(i).padStart(2, "0")}`,
      );
      growth.push(subject);
      for (const voter of voters) await vote(client, voter.voter, subject, 20);
    }
    for (const subject of growth) await aggregate(driver, subject, 5);
    const doubled = await scores(
      [...base, ...growth],
      [
        8.125,
        8.125,
        5.625,
        ...base.slice(3).map(() => 3.125),
        ...growth.map(() => 8.125),
      ],
      epoch,
    );
    expect(
      new Set(doubled.map((hit) => hit._source.rating_prior_epoch)).size,
    ).toBe(1);
    await restart(old);
    const doubledOrder = [
      ...nameOrder([...base.slice(0, 2), ...growth]),
      base[2]!,
      ...nameOrder(base.slice(3)),
      unrated,
    ];
    await driver.indexing("paused");
    const beforeSwitch = await traverse(doubledOrder);
    await driver.indexing("running");
    const physicalBefore = (await indexed([base[1]!]))[0]!._index;
    const generation = await driver.rebuild();
    expect(generation.generation).toBeGreaterThan(0);
    expect((await indexed([base[1]!]))[0]!._index).not.toBe(physicalBefore);
    await restart(beforeSwitch);
    await driver.indexing("paused");
    await traverse(doubledOrder);

    // Current figure disclosure must reject a stale scored hit while Search is
    // stopped. The other 95 votes keep this within the same eligible epoch.
    const cleared = base[0]!;
    await vote(client, voters[0]!.voter, cleared, null);
    const four = await aggregate(driver, cleared, 4);
    expect(four).toMatchObject({ count: 4, remaining: 1 });
    expect(four).not.toHaveProperty("mean");
    expect(four).not.toHaveProperty("histogram");
    expect((await indexed([cleared]))[0]!._source.rating_score).toBe(8.125);
    const withoutCleared = doubledOrder.filter(
      (subject) => subject.id !== cleared.id,
    );
    for (const persona of ["anonymous", "editor"] as const)
      await traverse(withoutCleared, persona);
    for (const voter of voters.slice(1))
      await vote(client, voter.voter, cleared, null);
    expect((await aggregate(driver, cleared, 0)).count).toBe(0);
    for (const persona of ["anonymous", "editor"] as const)
      await traverse(withoutCleared, persona);

    const hidden = base[1]!;
    const takenDown = base[2]!;
    await driver.remove(hidden.id, "hidden");
    await driver.remove(takenDown.id, "taken_down");
    const survivors = withoutCleared.filter(
      (subject) => subject.id !== hidden.id && subject.id !== takenDown.id,
    );
    for (const persona of ["anonymous", "editor"] as const) {
      await traverse(survivors, persona);
      for (const subject of [hidden, takenDown]) {
        problem(
          await driver.request(persona, "GET", `/v1/subjects/${subject.id}`),
          404,
          "not_found",
        );
        problem(
          await driver.request(
            persona,
            "GET",
            `/v1/subjects/${subject.id}/ratings?question=${question}&population=${driver.globalContext}`,
          ),
          404,
          "not_found",
        );
      }
    }
    await driver.indexing("running");
    await scores([cleared], [null]);

    // Delete fifty real answers: at most 45 remain (moderation may already have
    // removed ten). The active prior ends; a valid old token must restart.
    const beforeEnd = page(await search()).next!;
    expect(beforeEnd).toBeString();
    for (const subject of growth)
      for (const voter of voters)
        await vote(client, voter.voter, subject, null);
    for (const subject of growth) await aggregate(driver, subject, 0);
    await scores(
      base.slice(3),
      base.slice(3).map(() => null),
    );
    await restart(beforeEnd);
    await driver.indexing("paused");
    await traverse(
      nameOrder([
        ...base.filter(
          (subject) => subject !== hidden && subject !== takenDown,
        ),
        ...growth,
        unrated,
      ]),
    );
  } finally {
    // Captured runner cleanup targets the current runner, even after pause/rebuild.
    await client.close();
  }
}, 600_000);
