# REZICS kernel client

`@rezics/client` is the typed Eden client for the REZICS kernel API.

```ts
import { createKernelClient } from '@rezics/client';

const client = createKernelClient('https://kernel.example');
const { data, error } = await client.subjects({ id: 'subject-id' }).get();

if (error) {
  console.error(error.value);
} else {
  console.log(data.subject);
}
```

Each client keeps its own session token. It sends the initial `session` token, then stores and sends back any updated
token returned by the kernel. Use `onSession` to observe token changes, for example to persist the latest token.

The declarations in `src/kernel/` are generated through managed compiler placement by
`bun run --cwd services/kernel typecheck --emit-client`.

Decision: `POST /v1/definitions/imports` (`definitions.import`) is admitted by the generated
`definitions.imports` route. Callers keep authenticated transport and do not hand-edit declarations.
ClientApp SharedRoutes yields to that generated method when emission includes it and otherwise
keeps the mounted import request and the producer ImportedPreview (kind, identity, diagnostics,
comparison, types, current, reconciliation, operations, document). Fewest tests pin that installed
route and typed readback of those admitted fields. Runtime schemas and SQL declarations stay on
the generated kernel client; this package does not re-declare them.

The Zone subject-list route type is the emitted `kernel/zones/subjects` declaration. The publisher
records the importing public declaration and specifier when that file is absent from emit output.
A SubjectRoutes alias is not a substitute for that emission.

Decision: until whole-Kernel declaration emission succeeds, the personal VNDB binding mirrors the mounted
Progress selection/result and conditional-vote additions in `services/kernel/src/library/list-import-vndb-routes.ts`.
It preserves the generated methods and authenticated transport and yields to the generated Progress review union
when that union is present on the installed `libraryImports.vndb` method.

Decision: merge admission and poll types derive from the generated `subjects.$merge` 202 body and
`subjectIdentityOperations` read route. Callers keep authenticated transport; a synchronous 200 merge is not admission.

Decision: until declaration emission succeeds, the Copy list compatibility seam mirrors the mounted native
kind/status query and filterOptions schema; Web derives its wire types only from this official client.
The seam automatically yields to the generated method when its filterOptions envelope is published.

Decision: `GET /v1/accounts/{accountId}/verification` (`account.read_verification_request`) closes
`{ verificationRequest, viewerActions }`. e9314e51 publishes that generated closure; this Settings consumer
decodes the extra JSON field strictly and does not hand-edit declarations or emit a second client.

Decision: the preparation read uses a local `KernelClient` type seam over the generated publication path until its generated route declaration is installed; the DTO remains defined in `src/kernel/community/publication-preparation.ts`.

Decision: client assertions follow [Content's authoring contract](../../services/kernel/src/content/README.md):
post creation accepts protected visibility; revisions accept only published or draft visibility.

Decision: the official generator copies Realm question-management and caption-history schemas as installed runtime
modules (`CLIENT_RUNTIME_ENTRIES` in `services/kernel/scripts/client.ts`). Public `QuestionManagementPage`,
`QuestionLabelHistory`, `QuestionCreateResult`, `QuestionLabelResult` and `QuestionLifecycleResult` stay derived
from the mounted callables; Web receiving uses those types and the published schemas, not a Kernel path. Create
acknowledgement reads the installed POST data union and compares the mounted 201 body; treaty optional-field and
literal widening is not a second public type.

Decision: installed declarations resolve SQL modules through `.sql.d.ts`, not `.sql` specifiers, so a consumer
Reylo mapper cannot load Kernel SQL sources. Diary page types are the installed `DiaryPage` / `DiaryOccurrence`
exports; Web must not import Kernel source for them. Web tooling scripts compile in their own Bun/Node program,
invoked by the normal Web typecheck; its explicit script roots include the recorder, check runner and seeded Content
walk without Worker ambient types.

Reviewed Person admissions expose `identityOperationLocation` and `identityOperationId` from the public Client entry.
Consumers retain the native HTTP 202 Location bound to the returned operation identity and poll through
`reviewedPersonRequests(...).operationAt`; a missing Location cannot become a reconstructed admission.

Decision: exact post point responses publish `ContributedPostEntry` and the Accounts contribution attribution types
through the official Kernel declaration emitter. The public response may omit `authorId` for explicit deletion;
native Content authorization types retain their required author. A null attribution carries no deletion assertion.
