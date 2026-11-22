# Launcher distribution

The [desktop owner contract](../../../../docs/launcher.md) describes how the Launcher uses this catalogue.

The Launcher catalogue owns curated, versioned download metadata. It exposes four anonymous reads under
`/v1/launcher/packages`.

| Read                                                         | Result                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/launcher/packages?kind=overlay-panel&q=guide`       | One page of public packages. The required kind is `overlay-panel` or `minecraft-mod`. Omit `q` to browse by package ID or use a normalized title prefix. |
| `GET /v1/launcher/packages/{packageId}`                      | The package and its optional currently visible Subject link.                                                                                             |
| `GET /v1/launcher/packages/{packageId}/releases`             | The newest published releases first.                                                                                                                     |
| `GET /v1/launcher/packages/{packageId}/releases/{releaseId}` | The exact version, kind-specific compatibility, HTTPS artifact URL, byte size, SHA-256 and required release IDs.                                         |

Pages return at most 25 items with an optional next cursor. Continue with the same kind and query or the same
package ID. Reads use current state and the client verifies the artifact against the exact release metadata.
Withdrawing the last published release removes a package from discovery. Existing local installations remain
under the Launcher's control. A missing required release prevents a fresh install that depends on it.

A curator with `launcher:publish` on the Global Context can POST `{ package, release }` to the package's release
collection. The package ID is namespaced and must agree with both request records. Compatibility declares
a Launcher version range for Overlay panels or an exact Minecraft game version and Fabric loader for mods.
A release may require one already published release each from up to 16 other packages of the same kind. Minecraft dependencies
must target the same game version and loader. Both the release ID and display version are unique within the
package. A later release can add a new artifact without changing the older one.

A curator with `launcher:withdraw` can POST to the release path with the `:withdraw` suffix. Publication and
withdrawal use the ordinary `launcher_distribution` exposure gate, native command authorization, structured
`Idempotency-Key`, receipt, event and session token. Release metadata is immutable after publication. The
withdrawal state retains the identity, so another publish cannot assign new bytes to it. The kernel records
where to download an artifact of up to 2 GiB, with a 16 KiB limit for an Overlay panel. The external host serves
the bytes directly.

## Native bounds

The catalogue lives on the Global partition. A package is visible while its active release count is positive.
Publishing and withdrawal change this count and the release row inside one authorized transaction. Publication
does up to 16 exact dependency lookups, one package upsert and one release insert in addition to the fixed
command work. Withdrawal changes at most one release and its one package. No reverse-dependency scan occurs.

The package browse and prefix search use separate partial B-tree indexes over visible packages. The release
list uses a partial index keyed by package, publish time and ID. A page seeks once, reads at most 26 candidates
and probes at most 25 unique Subject keys through Semantic. Exact release lookup uses the composite primary
key. Work depends on index depth, page size and required releases. Withdrawn releases and unrelated packages
add no page work beyond index depth.
