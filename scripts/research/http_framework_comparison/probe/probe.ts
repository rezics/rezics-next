import assert from "node:assert/strict";
import { Elysia, problem, t } from "elysia";
import { openapi } from "@elysia/openapi";
import { cors as elysiaCors } from "@elysia/cors";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors as honoCors } from "hono/cors";
import { streamSSE } from "hono/streaming";

// Synthetic handler: verifies Fetch/cookie forwarding, not Better Auth or OIDC.
const authHandler = () => {
  const headers = new Headers();
  headers.append("Set-Cookie", "session=fixture; HttpOnly; Path=/");
  headers.append("Set-Cookie", "state=fixture; HttpOnly; Path=/");
  return new Response("fixture", { headers });
};
const input = { title: "Work", sequence: "9007199254740993" };
const elysiaSchema = t.Object({
  title: t.String(),
  sequence: t.String({ pattern: "^(0|[1-9][0-9]*)$" }),
});
const honoSchema = z.object({
  title: z.string(),
  sequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
let elysiaEffects = 0;
const elysia = new Elysia()
  .use(elysiaCors({ origin: "https://example.test" }))
  .use(openapi())
  .post("/items", { body: elysiaSchema, response: elysiaSchema }, ({ body }) => body)
  .post("/guarded", {
    beforeHandle: () => problem(403, { detail: "Denied fixture" }),
  }, () => { elysiaEffects++; return "must not execute"; })
  .get("/bad-response", { response: elysiaSchema }, () => {
    // Intentionally lie at the type boundary to test runtime response enforcement.
    return { title: 123, sequence: input.sequence } as unknown as typeof input;
  })
  .mount("/auth", authHandler)
  .get("/stream", () => new Response("data: one\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  }));

let honoEffects = 0;
const hono = new OpenAPIHono();
hono.use("*", honoCors({ origin: "https://example.test" }));
hono.openapi(createRoute({
  method: "post", path: "/items",
  request: { body: { required: true, content: { "application/json": { schema: honoSchema } } } },
  responses: { 200: { description: "Item", content: { "application/json": { schema: honoSchema } } } },
}), c => c.json(c.req.valid("json"), 200));
hono.use("/guarded", async c => c.json({ error: "Denied fixture" }, 403));
hono.post("/guarded", c => { honoEffects++; return c.text("must not execute"); });
hono.openapi(createRoute({
  method: "get", path: "/bad-response",
  responses: { 200: { description: "Item", content: { "application/json": { schema: honoSchema } } } },
}), c => c.json({ title: 123, sequence: input.sequence } as unknown as typeof input, 200));
hono.get("/checked-response", c => {
  const parsed = honoSchema.safeParse({ title: 123, sequence: input.sequence });
  return parsed.success ? c.json(parsed.data) : c.json({ error: "Invalid response fixture" }, 500);
});
hono.all("/auth/*", authHandler);
hono.get("/stream", c => streamSSE(c, async stream => { await stream.writeSSE({ data: "one" }); }));
hono.doc31("/openapi/json", { openapi: "3.1.0", info: { title: "Probe", version: "1" } });

type Fetcher = (request: Request) => Response | Promise<Response>;
const fetchers: Record<string, Fetcher> = {
  elysia: request => elysia.handle(request),
  hono: async request => hono.fetch(request),
};
const results: Record<string, unknown> = {};
// In beta.4, provider:null returns before registering either UI or JSON routes.
const headless = new Elysia().use(openapi({ provider: null })).get("/example", () => "ok");
const headlessSpec = await headless.handle(new Request("http://localhost/openapi/json"));
assert.equal(headlessSpec.status, 404);
for (const [name, fetcher] of Object.entries(fetchers)) {
  const request = (path: string, init?: RequestInit) => fetcher(new Request(`http://localhost${path}`, init));
  const post = (value: unknown) => request("/items", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  const valid = await post(input);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), input);
  const invalid = await post({ ...input, title: 123 });
  assert.ok(invalid.status >= 400 && invalid.status < 500);
  const invalidNumber = await post({ ...input, sequence: 9007199254740992 });
  assert.ok(invalidNumber.status >= 400 && invalidNumber.status < 500);
  const denied = await request("/guarded", { method: "POST" });
  assert.equal(denied.status, 403);
  assert.equal(name === "elysia" ? elysiaEffects : honoEffects, 0);
  const auth = await request("/auth/session");
  assert.equal(auth.status, 200);
  assert.equal(auth.headers.getSetCookie().length, 2);
  const preflight = await request("/items", { method: "OPTIONS", headers: {
    Origin: "https://example.test", "Access-Control-Request-Method": "POST",
  } });
  assert.ok(preflight.ok);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://example.test");
  const specResponse = await request("/openapi/json");
  assert.equal(specResponse.status, 200);
  const spec = await specResponse.json();
  assert.match(spec.openapi, /^3\./);
  assert.ok(spec.paths["/items"].post.requestBody.content["application/json"].schema);
  assert.ok(spec.paths["/items"].post.responses["200"].content["application/json"].schema);
  const stream = await request("/stream");
  assert.match(stream.headers.get("Content-Type") ?? "", /text\/event-stream/);
  assert.match(await stream.text(), /data: one/);
  const badResponse = await request("/bad-response");
  if (name === "elysia") {
    assert.ok(badResponse.status >= 500);
    assert.match(invalid.headers.get("Content-Type") ?? "", /application\/problem\+json/);
  } else {
    assert.equal(badResponse.status, 200);
    assert.equal((await badResponse.json()).title, 123);
    assert.equal((await request("/checked-response")).status, 500);
  }
  results[name] = {
    validRequestAndLosslessString: true,
    invalidRequestStatus: invalid.status,
    invalidNumericSequenceStatus: invalidNumber.status,
    deniedBeforeEffect: true,
    fetchHandlerCookieCount: auth.headers.getSetCookie().length,
    corsPreflight: true,
    openapiVersion: spec.openapi,
    requestAndResponseSchemasExported: true,
    finiteEventStream: true,
    malformedDeclaredResponseStatus: badResponse.status,
    explicitHonoResponseValidation: name === "hono" ? true : null,
  };
}
console.log(JSON.stringify({
  runtime: `bun ${Bun.version}`,
  elysiaVersion: "2.0.0-beta.16",
  honoVersion: "4.13.8",
  elysiaOpenapiProviderNullSpecStatus: headlessSpec.status,
  results,
}, null, 2));
