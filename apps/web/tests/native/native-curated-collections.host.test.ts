import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Page, Response as PlaywrightResponse } from "playwright";
import {
  startNativeCuratedCollectionsFixture,
  type NativeCuratedCollectionsFixture,
  type NativeCuratedSubject,
} from "./native-curated-collections-fixture.ts";

setDefaultTimeout(900_000);

let fixture: NativeCuratedCollectionsFixture;
let pageResponses: { url: string; method: string; status: number }[] = [];

beforeEach(async () => {
  fixture = await startNativeCuratedCollectionsFixture();
  pageResponses = [];
});

afterEach(async () => {
  await fixture?.close();
});

type NativeCollection = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: "private" | "unlisted" | "public";
  revision: number;
  memberCount: number;
};
type NativeMember = {
  id: string;
  subjectId: string;
  note: string | null;
  addedAt: string;
};
type NativePage<T> = { items: T[]; next: string | null };

function observePage(page: Page): void {
  page.on("response", (response: PlaywrightResponse) => {
    pageResponses.push({
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
    });
  });
  page.on("requestfailed", (request) => {
    pageResponses.push({
      url: request.url(),
      method: request.method(),
      status: 0,
    });
  });
}

async function pageReady(page: Page): Promise<void> {
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}

function occurrenceRow(page: Page, id: string) {
  return page.locator(`li[data-slot="list-row"][data-member="${id}"]`);
}

async function json<T>(
  response: Response,
  status: number,
  action: string,
): Promise<T> {
  const raw = await response.text();
  expect(response.status, `${action}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function nativeCollection(
  id: string,
  persona: "alice" | "bob" | "anonymous" = "alice",
): Promise<NativeCollection> {
  const body = await json<{ collection: NativeCollection }>(
    await fixture.stack.kernel(
      `/v1/collections/${encodeURIComponent(id)}`,
      {},
      persona,
    ),
    200,
    `Read native Collection ${id} as ${persona}`,
  );
  return body.collection;
}

async function nativeMembers(
  id: string,
  persona: "alice" | "bob" | "anonymous" = "alice",
  limit = 2,
): Promise<NativeMember[]> {
  const result: NativeMember[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: String(limit), view: "FULL" });
    if (cursor) query.set("cursor", cursor);
    const response = await json<{
      members: NativeMember[];
      next: string | null;
    }>(
      await fixture.stack.kernel(
        `/v1/collections/${encodeURIComponent(id)}/members?${query}`,
        {},
        persona,
      ),
      200,
      `Read native member page as ${persona}`,
    );
    result.push(...response.members);
    if (response.next === null) return result;
    expect(response.members.length).toBeGreaterThan(0);
    expect(cursors.has(response.next)).toBe(false);
    cursors.add(response.next);
    cursor = response.next;
  }
  throw new Error(
    `Native Collection cursor traversal did not finish for ${id}`,
  );
}

async function addSubjectFromSubjectPage(
  page: Page,
  subject: NativeCuratedSubject,
  collectionTitle: string,
  times = 1,
): Promise<void> {
  await page.goto(new URL(subject.href, fixture.stack.web).href, {
    waitUntil: "domcontentloaded",
  });
  await pageReady(page);
  const disclosure = page.locator("details[data-add-to-collection]");
  const summary = disclosure.locator("summary");
  if (
    !(await disclosure.evaluate(
      (element) => (element as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
  const load = disclosure.getByRole("button", {
    name: "Load collections",
    exact: true,
  });
  if (await load.isVisible()) {
    const response = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("_serverFn"),
      ),
      load.click(),
    ]).then(([result]) => result);
    expect(response.status()).toBeLessThan(400);
  }
  const collection = disclosure.getByRole("button", {
    name: new RegExp(collectionTitle, "i"),
  });
  await expect(collection).toBeVisible();
  for (let index = 0; index < times; index++) {
    const response = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("_serverFn"),
      ),
      collection.click(),
    ]).then(([result]) => result);
    expect(response.status()).toBeLessThan(400);
    await expect(
      page.getByRole("alert").filter({ hasText: "Added to collection." }),
    ).toBeVisible();
  }
}

async function setVisibility(
  page: Page,
  visibility: "private" | "unlisted" | "public",
): Promise<void> {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(visibility, "i") }).click();
  const response = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("_serverFn"),
    ),
    page.getByRole("button", { name: "Save collection", exact: true }).click(),
  ]).then(([result]) => result);
  expect(response.status()).toBeLessThan(400);
}

async function clickServerAction(
  page: Page,
  click: () => Promise<unknown>,
): Promise<PlaywrightResponse> {
  const response = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("_serverFn"),
    ),
    click(),
  ]).then(([result]) => result);
  expect(response.status()).toBeLessThan(400);
  return response;
}

async function readProblem(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function withoutRequestId(problem: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(problem).filter(([name]) => name !== "request_id"),
  );
}

function jsonLdSubjects(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("itemListElement" in value))
    return [];
  const elements = (value as { itemListElement?: unknown }).itemListElement;
  if (!Array.isArray(elements)) return [];
  return elements.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const item = (entry as { item?: unknown }).item;
    if (!item || typeof item !== "object" || !("@id" in item)) return "";
    return String((item as { "@id": unknown })["@id"]);
  });
}

async function idempotentCollectionUpdate(
  id: string,
  revision: number,
  key: string,
  title: string,
  visibility: NativeCollection["visibility"],
): Promise<NativeCollection> {
  const response = await fixture.stack.kernel(
    `/v1/collections/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": JSON.stringify(key),
      },
      body: JSON.stringify({ revision, title, visibility }),
    },
    "alice",
  );
  const body = await json<{ collection: NativeCollection }>(
    response,
    200,
    "Apply idempotent Collection revision",
  );
  return body.collection;
}

test("native curated Collections are edited, published, exported and withdrawn through served pages", async () => {
  const alicePage = await fixture.page("alice");
  const bobPage = await fixture.page("bob");
  const anonymousPage = await fixture.page("anonymous");
  observePage(alicePage);
  observePage(bobPage);
  observePage(anonymousPage);

  const collectionTitle = `Lantern shelf ${crypto.randomUUID().slice(0, 8)}`;
  const [firstSubject, secondSubject, hiddenSubject] = await Promise.all([
    fixture.createSubject(
      `Native curated first ${crypto.randomUUID().slice(0, 6)}`,
    ),
    fixture.createSubject(
      `Native curated second ${crypto.randomUUID().slice(0, 6)}`,
    ),
    fixture.createSubject(
      `Native curated hidden ${crypto.randomUUID().slice(0, 6)}`,
    ),
  ]);

  const beforeCollectionsPage = fixture.stack.kernelRequests().length;
  await alicePage.goto(
    new URL("/en/library/collections", fixture.stack.web).href,
    { waitUntil: "domcontentloaded" },
  );
  await pageReady(alicePage);
  const createCollectionLink = alicePage.getByRole("link", {
    name: "New collection",
    exact: true,
  });
  try {
    await createCollectionLink.waitFor({ state: "visible" });
  } catch (error) {
    const body = await alicePage
      .locator("body")
      .innerText()
      .catch(() => "<unavailable>");
    const exposureResponse = await fixture.stack.kernel(
      "/v1/platform/exposure",
      {},
      "alice",
    );
    const exposureBody = await exposureResponse.text();
    const kernelRequests = fixture.stack
      .kernelRequests()
      .slice(beforeCollectionsPage)
      .map(({ method, url, failure }) => ({
        method,
        url,
        status: failure?.status ?? 200,
        failure,
      }));
    throw new Error(
      `New collection link was unavailable at ${alicePage.url()}: ${body}; page responses=${JSON.stringify(pageResponses.filter(({ status }) => status >= 400))}; kernel requests=${JSON.stringify(kernelRequests)}; viewer exposure=${exposureResponse.status}: ${exposureBody}; web output=${fixture.stack.webOutput()}`,
      { cause: error },
    );
  }
  await createCollectionLink.click();
  await pageReady(alicePage);
  const titleInput = alicePage.getByRole("textbox", {
    name: "Title",
    exact: true,
  });
  await titleInput.fill(collectionTitle);
  const privateRadio = alicePage.getByRole("radio", { name: /Private/ });
  await privateRadio.click();
  const createFields = {
    title: await titleInput.inputValue(),
    idempotencyKey: await alicePage
      .locator('input[name="idempotencyKey"]')
      .inputValue(),
    visibilityChecked: await privateRadio.getAttribute("aria-checked"),
    radioHtml: await privateRadio.evaluate((element) => element.outerHTML),
  };
  expect(createFields.title).toBe(collectionTitle);
  expect(createFields.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(createFields.visibilityChecked).toBe("true");
  const createResponse = await clickServerAction(alicePage, () =>
    alicePage
      .getByRole("button", { name: "Create collection", exact: true })
      .click(),
  );
  const createResponseBody = await createResponse.text();
  try {
    await alicePage.waitForURL((url) =>
      /\/en\/collections\/[0-9a-f-]+$/i.test(url.pathname),
    );
  } catch (error) {
    const alerts = await alicePage.getByRole("alert").allTextContents();
    const exposureResponse = await fixture.stack.kernel(
      "/v1/platform/exposure",
      {},
      "alice",
    );
    const exposureBody = await exposureResponse.text();
    const kernelRequests = fixture.stack
      .kernelRequests()
      .slice(beforeCollectionsPage);
    throw new Error(
      `Collection creation did not navigate: url=${alicePage.url()}; fields=${JSON.stringify(createFields)}; server function response=${createResponseBody}; alerts=${JSON.stringify(alerts)}; kernel requests=${JSON.stringify(kernelRequests)}; viewer exposure=${exposureResponse.status}: ${exposureBody}; web output=${fixture.stack.webOutput()}`,
      { cause: error },
    );
  }
  const collectionId = decodeURIComponent(
    new URL(alicePage.url()).pathname.split("/").at(-1)!,
  );
  const privateCreated = await nativeCollection(collectionId);
  expect(privateCreated).toMatchObject({
    curatorAccountId: (await fixture.stack.authPersona("alice")).accountId,
    title: collectionTitle,
    visibility: "private",
    memberCount: 0,
  });

  await addSubjectFromSubjectPage(alicePage, firstSubject, collectionTitle, 2);
  await addSubjectFromSubjectPage(alicePage, secondSubject, collectionTitle);
  await addSubjectFromSubjectPage(alicePage, hiddenSubject, collectionTitle);

  const initialMembers = await nativeMembers(collectionId, "alice", 2);
  expect(initialMembers.map((member) => member.subjectId)).toEqual([
    firstSubject.id,
    firstSubject.id,
    secondSubject.id,
    hiddenSubject.id,
  ]);
  expect(new Set(initialMembers.map((member) => member.id)).size).toBe(4);

  await alicePage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await pageReady(alicePage);
  await alicePage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(alicePage);
  const reloadedMembers = await nativeMembers(collectionId, "alice", 2);
  expect(reloadedMembers.map(({ id }) => id)).toEqual(
    initialMembers.map(({ id }) => id),
  );
  expect(
    await alicePage
      .locator('li[data-slot="list-row"][data-member]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-member")),
      ),
  ).toEqual(initialMembers.map(({ id }) => id));
  const [
    firstOccurrence,
    duplicateOccurrence,
    secondOccurrence,
    hiddenOccurrence,
  ] = initialMembers;
  await clickServerAction(alicePage, () =>
    alicePage
      .locator(
        `li[data-slot="list-row"][data-member="${duplicateOccurrence!.id}"]`,
      )
      .getByRole("button", { name: "Move to top", exact: true })
      .click(),
  );
  await clickServerAction(alicePage, () =>
    alicePage
      .locator(
        `li[data-slot="list-row"][data-member="${duplicateOccurrence!.id}"]`,
      )
      .getByRole("button", { name: "Move down", exact: true })
      .click(),
  );
  await clickServerAction(alicePage, () =>
    alicePage
      .locator(
        `li[data-slot="list-row"][data-member="${duplicateOccurrence!.id}"]`,
      )
      .getByRole("button", { name: "Move down", exact: true })
      .click(),
  );
  await clickServerAction(alicePage, () =>
    alicePage
      .locator(
        `li[data-slot="list-row"][data-member="${duplicateOccurrence!.id}"]`,
      )
      .getByRole("button", { name: "Move down", exact: true })
      .click(),
  );
  await clickServerAction(alicePage, () =>
    alicePage
      .locator(
        `li[data-slot="list-row"][data-member="${hiddenOccurrence!.id}"]`,
      )
      .getByRole("button", { name: "Move to top", exact: true })
      .click(),
  );
  for (const [occurrence, note] of [
    [firstOccurrence!, "First occurrence note"],
    [duplicateOccurrence!, "Duplicate occurrence note"],
  ] as const) {
    const row = occurrenceRow(alicePage, occurrence.id);
    await row.getByRole("textbox", { name: "Note", exact: true }).fill(note);
    await clickServerAction(alicePage, () =>
      row.getByRole("button", { name: "Save note", exact: true }).click(),
    );
    await expect(row.getByText(note, { exact: true })).toBeVisible();
  }
  const ordered = await nativeMembers(collectionId, "alice", 2);
  expect(ordered.map((member) => member.id)).toEqual([
    hiddenOccurrence!.id,
    firstOccurrence!.id,
    secondOccurrence!.id,
    duplicateOccurrence!.id,
  ]);
  expect(
    ordered.find((member) => member.id === firstOccurrence!.id)?.note,
  ).toBe("First occurrence note");
  expect(
    ordered.find((member) => member.id === duplicateOccurrence!.id)?.note,
  ).toBe("Duplicate occurrence note");

  const beforeStale = await nativeCollection(collectionId);
  const outside = await json<{ collection: NativeCollection }>(
    await fixture.stack.kernel(
      `/v1/collections/${collectionId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({
          revision: beforeStale.revision,
          title: `${collectionTitle} external`,
        }),
      },
      "alice",
    ),
    200,
    "Create a stale editor revision through the native API",
  );
  await alicePage
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await alicePage.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await alicePage
    .getByRole("textbox", { name: "Title", exact: true })
    .fill(`${collectionTitle} stale`);
  await alicePage
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await expect(alicePage.getByRole("alert")).toContainText(
    "Your changes are still here.",
  );
  await alicePage
    .getByRole("link", { name: "Load the current version", exact: true })
    .click();
  await expect(
    alicePage.getByRole("heading", {
      level: 1,
      name: `${collectionTitle} external`,
    }),
  ).toBeVisible();

  const staleKey = crypto.randomUUID();
  const staleHeaders = {
    "content-type": "application/json",
    "idempotency-key": JSON.stringify(staleKey),
  };
  const staleBody = JSON.stringify({
    revision: beforeStale.revision,
    title: "Must not win",
  });
  for (let replay = 0; replay < 2; replay++) {
    const staleResponse = await fixture.stack.kernel(
      `/v1/collections/${collectionId}`,
      { method: "PATCH", headers: staleHeaders, body: staleBody },
      "alice",
    );
    expect(staleResponse.status).toBe(409);
    await staleResponse.body?.cancel();
  }
  expect(await nativeCollection(collectionId)).toEqual(outside.collection);

  const updated = await idempotentCollectionUpdate(
    collectionId,
    outside.collection.revision,
    crypto.randomUUID(),
    `${collectionTitle} final`,
    "private",
  );
  const replayKey = crypto.randomUUID();
  const replayed = await idempotentCollectionUpdate(
    collectionId,
    updated.revision,
    replayKey,
    `${collectionTitle} replay-safe`,
    "private",
  );
  expect(
    await idempotentCollectionUpdate(
      collectionId,
      updated.revision,
      replayKey,
      `${collectionTitle} replay-safe`,
      "private",
    ),
  ).toEqual(replayed);
  expect((await nativeCollection(collectionId)).revision).toBe(
    replayed.revision,
  );
  await alicePage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(alicePage);
  await expect(
    alicePage.getByRole("heading", {
      level: 1,
      name: `${collectionTitle} replay-safe`,
    }),
  ).toBeVisible();

  await setVisibility(alicePage, "unlisted");
  const unlistedPageResponse = await json<{ collection: NativeCollection }>(
    await fixture.stack.kernel(
      `/v1/collections/${collectionId}`,
      {},
      "anonymous",
    ),
    200,
    "Read known unlisted Collection link anonymously",
  );
  expect(unlistedPageResponse.collection.visibility).toBe("unlisted");
  expect(await nativeMembers(collectionId, "anonymous", 20)).toEqual([]);
  await anonymousPage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await pageReady(anonymousPage);
  await expect(
    anonymousPage.getByRole("heading", {
      level: 1,
      name: `${collectionTitle} replay-safe`,
    }),
  ).toBeVisible();
  await expect(anonymousPage.locator("[data-member]")).toHaveCount(0);
  await expect(
    anonymousPage.locator("article").getByText("0 members", { exact: true }),
  ).toBeVisible();
  await expect(
    anonymousPage.locator('script[type="application/ld+json"]'),
  ).toHaveCount(0);
  const anonymousCatalogue = await json<{
    collections: NativeCollection[];
    next: string | null;
  }>(
    await fixture.stack.kernel(
      `/v1/accounts/${(await fixture.stack.authPersona("alice")).accountId}/collections?limit=100`,
      {},
      "anonymous",
    ),
    200,
    "Read Alice public Collection catalogue while the target is unlisted",
  );
  expect(
    anonymousCatalogue.collections.some(
      (collection) => collection.id === collectionId,
    ),
  ).toBe(false);

  await alicePage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(alicePage);
  await setVisibility(alicePage, "public");
  await fixture.hideSubject(hiddenSubject.id);
  const anonymousMembers = await nativeMembers(collectionId, "anonymous", 2);
  expect(anonymousMembers.map((member) => member.subjectId)).toEqual([
    firstSubject.id,
    secondSubject.id,
    firstSubject.id,
  ]);
  const publicCollection = await nativeCollection(collectionId, "anonymous");
  expect(publicCollection.visibility).toBe("public");
  const publicCatalogue = await json<{
    collections: NativeCollection[];
    next: string | null;
  }>(
    await fixture.stack.kernel(
      `/v1/accounts/${(await fixture.stack.authPersona("alice")).accountId}/collections?limit=100`,
      {},
      "anonymous",
    ),
    200,
    "Discover a public Collection through the owner catalogue",
  );
  expect(publicCatalogue.collections.map(({ id }) => id)).toContain(
    collectionId,
  );

  await anonymousPage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await pageReady(anonymousPage);
  await expect(
    anonymousPage.getByRole("heading", {
      level: 1,
      name: `${collectionTitle} replay-safe`,
    }),
  ).toBeVisible();
  const countText = await anonymousPage
    .locator("article")
    .getByText(/\d+ members?/, { exact: false })
    .first()
    .textContent();
  const canonical = await anonymousPage
    .locator('link[rel="canonical"]')
    .getAttribute("href");
  const rawJsonLd = await anonymousPage
    .locator('script[type="application/ld+json"]')
    .first()
    .textContent()
    .catch(() => null);
  const parsedJsonLd: unknown = rawJsonLd ? JSON.parse(rawJsonLd) : null;
  const exportedSubjects = jsonLdSubjects(parsedJsonLd);
  const shownSubjectLinks = await anonymousPage
    .locator("li[data-member] > a[href]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).href),
    );
  const publicRequestCount = (await fixture.stack.kernelRequests()).filter(
    ({ url }) => url.startsWith(`/v1/collections/${collectionId}`),
  ).length;
  await expect(
    anonymousPage.getByText("First occurrence note", { exact: true }),
  ).toBeVisible();
  await expect(
    anonymousPage.getByText("Duplicate occurrence note", { exact: true }),
  ).toBeVisible();

  const bobBefore = await nativeMembers(collectionId, "bob", 20);
  const bobCollectionBefore = await nativeCollection(collectionId, "bob");
  const bobWrites = [
    {
      path: `/v1/collections/${collectionId}`,
      method: "PATCH",
      body: { revision: publicCollection.revision, title: "Bob edit" },
    },
    {
      path: `/v1/collections/${collectionId}?revision=${publicCollection.revision}`,
      method: "DELETE",
    },
    {
      path: `/v1/collections/${collectionId}/members`,
      method: "POST",
      body: { subjectId: firstSubject.id },
    },
    {
      path: `/v1/collections/${collectionId}/members/${duplicateOccurrence!.id}`,
      method: "PATCH",
      body: { note: "Bob edit" },
    },
    {
      path: `/v1/collections/${collectionId}/members/${duplicateOccurrence!.id}:move`,
      method: "POST",
      body: { after: null },
    },
    {
      path: `/v1/collections/${collectionId}/members/${duplicateOccurrence!.id}`,
      method: "DELETE",
    },
  ] as const;
  for (const write of bobWrites) {
    const deniedMutation = await fixture.stack.kernel(
      write.path,
      {
        method: write.method,
        headers: {
          ...(write.body ? { "content-type": "application/json" } : {}),
          "idempotency-key": JSON.stringify(crypto.randomUUID()),
        },
        ...(write.body ? { body: JSON.stringify(write.body) } : {}),
      },
      "bob",
    );
    expect([403, 404]).toContain(deniedMutation.status);
    await deniedMutation.body?.cancel();
    expect(await nativeMembers(collectionId, "bob", 20)).toEqual(bobBefore);
    expect(await nativeCollection(collectionId, "bob")).toEqual(
      bobCollectionBefore,
    );
  }

  const onePrivate = await fixture.createPrivateCollection(
    `unrelated one ${crypto.randomUUID().slice(0, 8)}`,
  );
  const firstCostStart = fixture.stack.kernelRequests().length;
  await anonymousPage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(anonymousPage);
  const costAtOne = fixture.stack
    .kernelRequests()
    .slice(firstCostStart)
    .filter(({ url }) =>
      url.startsWith(`/v1/collections/${collectionId}`),
    ).length;
  expect(onePrivate).toBeDefined();
  for (let index = 1; index < 8; index++)
    await fixture.createPrivateCollection(
      `unrelated eight ${index} ${crypto.randomUUID().slice(0, 6)}`,
    );
  const eightCostStart = fixture.stack.kernelRequests().length;
  await anonymousPage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(anonymousPage);
  const costAtEight = fixture.stack
    .kernelRequests()
    .slice(eightCostStart)
    .filter(({ url }) =>
      url.startsWith(`/v1/collections/${collectionId}`),
    ).length;
  for (let index = 8; index < 64; index++)
    await fixture.createPrivateCollection(
      `unrelated sixty-four ${index} ${crypto.randomUUID().slice(0, 6)}`,
    );
  const sixtyFourCostStart = fixture.stack.kernelRequests().length;
  await anonymousPage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(anonymousPage);
  const costAtSixtyFour = fixture.stack
    .kernelRequests()
    .slice(sixtyFourCostStart)
    .filter(({ url }) =>
      url.startsWith(`/v1/collections/${collectionId}`),
    ).length;
  console.info(
    `native-curated-collections-growth page-kernel-requests: 1=${costAtOne} 8=${costAtEight} 64=${costAtSixtyFour}`,
  );
  expect(costAtEight).toBe(costAtOne);
  expect(costAtSixtyFour).toBe(costAtOne);
  expect(publicRequestCount).toBeGreaterThan(0);

  const collectionBeforeRemoval = await nativeCollection(collectionId);
  const publicMembersBeforeRemoval = await nativeMembers(
    collectionId,
    "alice",
    100,
  );
  const removeOccurrence = publicMembersBeforeRemoval.find(
    (member) => member.id === duplicateOccurrence!.id,
  )!;
  const row = occurrenceRow(alicePage, removeOccurrence.id);
  await row
    .getByRole("checkbox", { name: "Remove this member", exact: true })
    .check();
  await clickServerAction(alicePage, () =>
    row.getByRole("button", { name: "Remove member", exact: true }).click(),
  );
  await expect(occurrenceRow(alicePage, removeOccurrence.id)).toHaveCount(0);
  const remainingOwnerMembers = await nativeMembers(collectionId, "alice", 100);
  expect(remainingOwnerMembers.map(({ id }) => id)).not.toContain(
    removeOccurrence.id,
  );
  expect((await nativeCollection(collectionId)).memberCount).toBe(
    collectionBeforeRemoval.memberCount - 1,
  );
  await anonymousPage.reload({ waitUntil: "domcontentloaded" });
  await pageReady(anonymousPage);
  expect(
    await anonymousPage
      .locator("[data-member] > a[href]")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).href),
      ),
  ).toEqual(
    [firstSubject.id, secondSubject.id].map(
      (id) =>
        `https://rezics.example.test${subjectHrefFor(id, [firstSubject, secondSubject])}`,
    ),
  );
  expect(
    await anonymousPage
      .locator("article")
      .getByText(/\d+ members?/, { exact: false })
      .first()
      .textContent(),
  ).toBe("2 members");
  const afterRemovalJsonLd = await anonymousPage
    .locator('script[type="application/ld+json"]')
    .textContent();
  expect(jsonLdSubjects(JSON.parse(afterRemovalJsonLd ?? "null"))).toEqual(
    [firstSubject.id, secondSubject.id].map(
      (id) =>
        `https://rezics.example.test${subjectHrefFor(id, [firstSubject, secondSubject])}`,
    ),
  );

  await setVisibility(alicePage, "private");
  const privateBob = await fixture.stack.kernel(
    `/v1/collections/${collectionId}`,
    {},
    "bob",
  );
  const missingBob = await fixture.stack.kernel(
    "/v1/collections/00000000-0000-8000-8000-000000000999",
    {},
    "bob",
  );
  expect(privateBob.status).toBe(404);
  expect(missingBob.status).toBe(404);
  expect(withoutRequestId(await readProblem(privateBob))).toEqual(
    withoutRequestId(await readProblem(missingBob)),
  );
  const privateAnonymous = await fixture.stack.kernel(
    `/v1/collections/${collectionId}`,
    {},
    "anonymous",
  );
  const missingAnonymous = await fixture.stack.kernel(
    "/v1/collections/00000000-0000-8000-8000-000000000999",
    {},
    "anonymous",
  );
  expect(privateAnonymous.status).toBe(404);
  expect(missingAnonymous.status).toBe(404);
  expect(withoutRequestId(await readProblem(privateAnonymous))).toEqual(
    withoutRequestId(await readProblem(missingAnonymous)),
  );

  const privateBobPage = await bobPage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    {
      waitUntil: "domcontentloaded",
    },
  );
  expect(privateBobPage?.status()).toBe(404);
  const privateBobText = await bobPage.locator("body").innerText();
  const missingBobPage = await bobPage.goto(
    new URL(
      "/en/collections/00000000-0000-8000-8000-000000000999",
      fixture.stack.web,
    ).href,
    { waitUntil: "domcontentloaded" },
  );
  expect(missingBobPage?.status()).toBe(404);
  expect(await bobPage.locator("body").innerText()).toBe(privateBobText);
  const privateAnonymousPage = await anonymousPage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    { waitUntil: "domcontentloaded" },
  );
  expect(privateAnonymousPage?.status()).toBe(404);
  const privateAnonymousText = await anonymousPage.locator("body").innerText();
  const missingAnonymousPage = await anonymousPage.goto(
    new URL(
      "/en/collections/00000000-0000-8000-8000-000000000999",
      fixture.stack.web,
    ).href,
    { waitUntil: "domcontentloaded" },
  );
  expect(missingAnonymousPage?.status()).toBe(404);
  expect(await anonymousPage.locator("body").innerText()).toBe(
    privateAnonymousText,
  );

  await setVisibility(alicePage, "public");

  await alicePage
    .getByRole("button", { name: "More actions", exact: true })
    .click();
  await alicePage
    .getByRole("menuitem", { name: "Delete", exact: true })
    .click();
  const dialog = alicePage.getByRole("alertdialog");
  await clickServerAction(alicePage, () =>
    dialog
      .getByRole("button", { name: "Delete collection", exact: true })
      .click(),
  );
  await alicePage.waitForURL((url) =>
    url.pathname.endsWith("/library/collections"),
  );
  const deleted = await fixture.stack.kernel(
    `/v1/collections/${collectionId}`,
    {},
    "alice",
  );
  expect(deleted.status).toBe(404);
  await deleted.body?.cancel();
  const anonymousAfterDelete = await anonymousPage.goto(
    new URL(`/en/collections/${collectionId}`, fixture.stack.web).href,
    { waitUntil: "domcontentloaded" },
  );
  expect(anonymousAfterDelete?.status()).toBe(404);
  const bobAfterDelete = await fixture.stack.kernel(
    `/v1/collections/${collectionId}/members`,
    {},
    "bob",
  );
  expect(bobAfterDelete.status).toBe(404);
  await bobAfterDelete.body?.cancel();

  expect(countText).toBe("3 items");
  expect(canonical).toBe(
    `https://rezics.example.test/en/collections/${collectionId}`,
  );
  expect(parsedJsonLd).toMatchObject({
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${collectionTitle} replay-safe`,
    url: canonical,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    numberOfItems: 3,
  });
  const itemListElements =
    parsedJsonLd &&
    typeof parsedJsonLd === "object" &&
    "itemListElement" in parsedJsonLd
      ? ((
          parsedJsonLd as {
            itemListElement?: { position: number; description?: string }[];
          }
        ).itemListElement ?? [])
      : [];
  expect(
    itemListElements.map(({ position, description }) => ({
      position,
      note: description ?? null,
    })),
  ).toEqual(
    anonymousMembers.map((member, index) => ({
      position: index + 1,
      note: member.note,
    })),
  );
  expect(exportedSubjects).toEqual(
    [firstSubject.id, secondSubject.id, firstSubject.id].map(
      (id) =>
        `https://rezics.example.test${subjectHrefFor(id, [firstSubject, secondSubject])}`,
    ),
  );
  expect(exportedSubjects.some((href) => href.includes(hiddenSubject.id))).toBe(
    false,
  );
  expect(JSON.stringify(parsedJsonLd)).not.toMatch(
    /alice|private|visibility|revision|curatorAccountId/i,
  );
  expect(shownSubjectLinks.map((href) => new URL(href).pathname)).toEqual(
    exportedSubjects.map((href) => new URL(href).pathname),
  );
  expect(
    pageResponses.some(
      ({ method, url, status }) =>
        method === "POST" && url.includes("_serverFn") && status < 400,
    ),
  ).toBe(true);
  expect(
    pageResponses.filter(({ status }) => status === 0 || status >= 500),
  ).toEqual([]);
  await bobPage.close();
  await anonymousPage.close();
  await alicePage.close();
});

function subjectHrefFor(id: string, subjects: NativeCuratedSubject[]): string {
  const subject = subjects.find((candidate) => candidate.id === id);
  if (!subject) throw new Error(`Unknown fixture subject ${id}`);
  return subject.href;
}
