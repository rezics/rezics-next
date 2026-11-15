# `@rezics/operations`

`@rezics/operations` is the framework-free catalogue of mounted operation descriptors. A descriptor names one route: method, path template, action, audience, security alternatives, exposure token, resource types, contract-reference names, and any replay, authority, or rate-limit token. Callers keep handlers, gate decisions, rate-limit enforcement, replay, and persistence.

The shipped descriptors are data accepted by `defineOperationDescriptors`. Route policy stays with the product owners: [independent progress measures](../../docs/library-progress-measures.md#record-and-correct) for `progress_session.record`, [Continue](../../docs/library-continue.md) for `library_continue.list`, and [Home and Following feeds](../../docs/feeds.md) for `feed_item.list`. A descriptor or catalogue from this package is a pure helper result. It does not establish API authorization or a completed business operation.

## Imports

The package is private, depends on no other package, and publishes two entries from `package.json`.

| Import | Module | Exports |
| --- | --- | --- |
| `@rezics/operations` | `src/index.ts` | Builders, descriptor types, both declaration arrays, and both header names |
| `@rezics/operations/protocol` | `src/protocol.ts` | `SESSION_HEADER` and `IDEMPOTENCY_HEADER` |

Root types are `OperationAudience`, `OperationAuthority`, `OperationCatalogue`, `OperationContractReferences`, `OperationDescriptor`, `OperationMethod`, `OperationRateLimit`, `OperationSecurity`, and `OperationSecurityScheme`.

## Descriptor model

`OPERATION_METHODS` is `['GET', 'POST', 'PUT', 'PATCH', 'DELETE']`. `OperationMethod` is a member of that tuple. Only that uppercase spelling is accepted.

```ts
type OperationSecurityScheme = 'anonymous' | 'bearerAuth';
type OperationSecurity = Readonly<{ scheme: OperationSecurityScheme }>;
type OperationAudience = 'account' | 'public';
type OperationRateLimit =
  | 'kernel.write.single'
  | 'kernel.write.commands'
  | 'kernel.provider.single';
type OperationContractReferences = Readonly<{
  params?: string;
  query?: string;
  headers?: string;
  body?: string;
  response: string;
}>;
type OperationAuthority = Readonly<{
  anchor: 'own-account';
  resourceTypes: readonly string[];
}>;
type OperationDescriptor = Readonly<{
  operationId: string;
  method: OperationMethod;
  path: string;
  action: string;
  audience: OperationAudience;
  security: readonly OperationSecurity[];
  exposure: string;
  resourceTypes: readonly string[];
  replayAuthorization?: 'self-account-read';
  authority?: OperationAuthority;
  rateLimit?: OperationRateLimit;
  contracts: OperationContractReferences;
}>;
type OperationCatalogue = Readonly<{
  get(operationId: string): OperationDescriptor | undefined;
  all(): readonly OperationDescriptor[];
}>;
```

## Builders and shipped values

`defineOperationDescriptors(input: readonly unknown[]): readonly OperationDescriptor[]` snapshots each element in input order and freezes the array. Cross-descriptor checks wait for composition.

`createOperationCatalogue(input: readonly unknown[]): OperationCatalogue` snapshots every element, sorts the copies, runs the checks below, and returns a frozen catalogue. `get` returns that operation's snapshot, or `undefined` when the id is absent. `all` returns the same frozen sorted array on every call. Both functions are pure in `input`: no database and no process-global registry. An empty array succeeds.

`LIBRARY_OPERATION_DECLARATIONS` and `FEED_OPERATION_DECLARATIONS` are separate frozen arrays. Contract fields are reference names. This package does not resolve them.

| `operationId` | Route | Action | Audience and security | Exposure | Tokens and contracts |
| --- | --- | --- | --- | --- | --- |
| `progress_session.record` | `POST /v1/progressSessions/:sessionId/$record` | `progress_session:update` | `account`, one `bearerAuth` | `gate:reading_progress` | `rateLimit` `kernel.write.single`. `params` `library.progress-session.record.params`, `headers` `library.idempotency.headers`, `body` `library.progress-session.record.request`, `response` `library.progress-session.write.response` |
| `library_continue.list` | `GET /v1/libraryContinue` | `library_entry:list` | `account`, one `bearerAuth` | `gate:personal_library` | `query` `library.continue.query`, `response` `library.continue.page` |
| `feed_item.list` | `GET /v1/feedItems` | `feed_item:list` | `public`, `anonymous` then `bearerAuth` | `public` | `query` `content.feed.items.query`, `response` `content.feed.page` |

Every shipped `resourceTypes` array is empty. None sets `replayAuthorization` or `authority`. Library array order is record, then continue. Feed is a one-element array.

`SESSION_HEADER` is `rezics-session-token`. `IDEMPOTENCY_HEADER` is `idempotency-key`. The root entry re-exports both. `./protocol` exports only those two constants: the header names shared with native command transport. Declaration objects do not read the constants.

## Example

```ts
import { createOperationCatalogue, LIBRARY_OPERATION_DECLARATIONS } from '@rezics/operations';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';

const catalogue = createOperationCatalogue(LIBRARY_OPERATION_DECLARATIONS);
const record = catalogue.get('progress_session.record');
// record?.method === 'POST'
// record?.path === '/v1/progressSessions/:sessionId/$record'
// record?.action === 'progress_session:update'
// record?.audience === 'account'
// record?.rateLimit === 'kernel.write.single'
// catalogue.all() operationIds: 'library_continue.list', then 'progress_session.record'
// catalogue.get('missing.operation') === undefined
// SESSION_HEADER === 'rezics-session-token'
// IDEMPOTENCY_HEADER === 'idempotency-key'
```

Finding `progress_session.record` does not authorize `progress_session:update` and does not record progress.

## Snapshot errors

Both builders throw `TypeError` from the snapshot. A value that is not a non-array object produces `operation: descriptor must be an object`. Every other message is `METHOD PATH [operationId]: reason`. A non-string method, path, or operation id is labeled `UNKNOWN`, `<missing path>`, or `<missing operationId>`. A string method is uppercased in the label only; acceptance still requires an `OPERATION_METHODS` member. The first failed check is the one thrown:

- Own keys are only `operationId`, `method`, `path`, `action`, `audience`, `security`, `exposure`, `resourceTypes`, `replayAuthorization`, `authority`, `rateLimit`, and `contracts`. Extra keys: `descriptor contains an unsupported field`.
- `operationId` matches `/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/`, or `operationId must be <resource>.<verb>`.
- `method` is an `OPERATION_METHODS` member, or `method must be a supported uppercase HTTP method`.
- `path` is a string, starts with `/`, contains neither `?` nor `#`, and does not end with `/`, or `path must be an absolute route template without query, fragment, or trailing slash`. The path `/` fails this rule.
- `action` matches `/^[a-z][a-z_]*:[a-z][a-z_]*$/`, or `action must be <resource>:<verb>`.
- `audience` is `account` or `public`, or `audience must be account or public`.
- `exposure` is `public` or matches `/^gate:[a-z][a-z0-9_]*$/`, or `exposure must be public or a named gate`.
- A segment that starts with `:` matches `/^:[A-Za-z_][A-Za-z0-9_]*$/`, or `path parameters must use a complete :name segment`. `$record` is a literal segment.
- `security` is a non-empty array, or `security must contain at least one alternative`. Each item is an object whose only key is `scheme`, and `scheme` is `anonymous` or `bearerAuth`, or `security alternatives must be anonymous or bearerAuth`. Repeated schemes: `security alternatives must be distinct`. Input order is kept.
- `account` has exactly one alternative and it is `bearerAuth`. `public` includes `anonymous`. Any other mix: `audience conflicts with security alternatives`.
- `resourceTypes` is an array of distinct strings matching `/^[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)?$/`. Empty is valid. Otherwise `resourceTypes must be a list of distinct resource type names`.
- Omitted `replayAuthorization` stays omitted. A present value must be `self-account-read`, or `unsupported replay authorization`.
- Omitted `authority` stays omitted. A present value is an object whose only keys are `anchor` and `resourceTypes`, with anchor `own-account`. A bad shape or anchor: `authority anchor must be own-account`. Its resource types use the list rule above, or `authority resourceTypes must be a list of distinct resource type names`.
- Omitted `rateLimit` stays omitted. A present value is one of the three `OperationRateLimit` strings, or `rateLimit must reference a supported rate contract`.
- `contracts` is an object whose only keys are `params`, `query`, `headers`, `body`, and `response`, and `response` matches `/^[a-z][A-Za-z0-9_.-]*$/`, or `contracts.response must reference a response contract`. Each present optional reference uses that pattern, or `contracts.<key> must be a contract reference`.

The snapshot freezes the descriptor, the `security` array, each security object, every resource-type array, `authority` when present, and `contracts`.

## Composition errors

When every snapshot succeeds, `createOperationCatalogue` sorts by `operationId`, then `method`, then `path`, using `<` and `>`. It throws `Error`. The message names the descriptor already stored, then the one just visited, as `METHOD PATH [operationId]`, then the reason:

- the same `operationId`: `duplicate operationId`;
- the same method and path: `duplicate mounted route`;
- the same `action` with a different security signature: `conflicting security for action <action>`.

The signature is the audience, a colon, and the scheme names sorted with `<` and joined by commas. The same action and the same signature stay on every matching descriptor.

Parameter names are checked after those maps, in the same sorted order. For each `:name` segment, the prefix is `path.split('/')` before that segment, and every parameter in the prefix is collapsed to `:`. A different name at the same prefix throws `inconsistent path parameter name at position <index>`, using the split index. `/v1/progressSessions/:sessionId/$record` and `/v1/progressSessions/:progressId/changes` conflict at position `3`.

Snapshot failures follow input order and precede sorting. Composition failures follow sorted order. `get` returns `undefined` for an unknown id and does not throw. Each catalogue call copies its inputs again; the frozen results do not alias the caller's objects.
