# `@rezics/access`

## Exposure policy core

The public entry, `@rezics/access`, owns the normalized exposure contract, mounted-operation catalogue facts and the
pure combining rule used by Kernel admission, discovery and management. Its exports are limited to
`./src/index.ts`. The package has no runtime dependencies and imports no service, application, HTTP router, SQL,
clock or environment. Time, opening state, actor kind, client scope and the result of native gate authority arrive as
explicit values; the package cannot acquire authority or opening state.

Kernel's `gates/declaration.ts` adapter reads trusted mounted `x-exposure` metadata and calls
`parseExposureDeclaration`. `gates/visibility.ts` reads the single mounted operation descriptor, including its
`x-action`, then passes immutable normalized operation values to `compileExposureCatalogue`. Neither method, path,
display text nor operation ID creates permission semantics. The package compiles sorted, deduplicated groups and
stable digest entries from those facts. `decideExposure` grants exposure for a public declaration, an open group, or
a closed group when an account has the mounted client scope and Kernel's native Global gate check succeeds.
`exposureAuthorityActions` supplies only `gate:<group>` and `gate:any`; Kernel retains exact Global resource checks,
actor and authenticated-principal evidence, permission preparation, refusal and unavailable handling.

Route declarations keep `^[a-z][a-z_]{0,62}$`. Native opening and gate-action inputs keep
`^[a-z][a-z_-]{0,62}$`. Both reject `any`, `open` and `close`; these separate profiles preserve their installed
admitted sets.

## Full-call bounds

The core adds no I/O, request cache, per-row permission check or history scan. Kernel retains these fixed deployment
bounds:

| Call | Existing full-call ceiling |
| --- | --- |
| Admission | One temporal opening point read; on a closed group, exact `gate:<group>` / `gate:any` checks on Global Context using the mounted action scope; `K <= 1,000`. |
| Discovery | One open-groups read and at most one gate authorization per in-scope closed group; linear in mounted `M`, with `G` and `M` fixed by deployment. |
| Management | One captured immutable deployment catalogue; keyset pages contain at most 100 groups and read each selected current opening once, with fixed native authority checks before and after disclosure. |

Opening satisfies exposure only. Route resource permission, native authority, temporal currentness and audit custody
remain with their existing Kernel owners.
