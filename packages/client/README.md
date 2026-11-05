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

Decision: until whole-Kernel declaration emission succeeds, the personal VNDB binding mirrors the mounted
Progress selection/result and conditional-vote additions in `services/kernel/src/library/list-import-vndb-routes.ts`.
It preserves the generated methods and authenticated transport and yields to the generated Progress review union.

Decision: until declaration emission succeeds, the Copy list compatibility seam mirrors the mounted native
kind/status query and filterOptions schema; Web derives its wire types only from this official client.
The seam automatically yields to the generated method when its filterOptions envelope is published.

Decision: `GET /v1/accounts/{accountId}/verification` (`account.read_verification_request`) closes
`{ verificationRequest, viewerActions }`. e9314e51 publishes that generated closure; this Settings consumer
decodes the extra JSON field strictly and does not hand-edit declarations or emit a second client.

Decision: the preparation read uses a local `KernelClient` type seam over the generated publication path until its generated route declaration is installed; the DTO remains defined in `src/kernel/community/publication-preparation.ts`.

Decision: client assertions follow [Content's authoring contract](../../services/kernel/src/content/README.md):
post creation accepts protected visibility; revisions accept only published or draft visibility.
