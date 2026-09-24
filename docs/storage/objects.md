# Object storage, payloads and artifacts

## Object contract

Store sealed semantic revision payloads/manifests, large Content payload pages,
original source captures, media and package artifacts under controlled namespaces.
Ordinary bounded JSON bodies and their Content revisions are PostgreSQL-owned;
see [Content storage](postgresql.md#content-records-and-exact-revisions). Object
storage is not the mandatory read path for every body. The existing object-backed
body implementation remains a migration baseline, not the selected target.
References declare digest algorithm/bytes, media type,
size, encoding/profile and retention/disclosure domain. A locator without observed
bytes does not claim content integrity. Dedupe only across compatible rights,
privacy and erasure boundaries; object existence cannot leak another user's upload.

## Lifecycle

Upload reservation -> quarantine -> verification/transformation -> graph/reference
activation. Multipart failures and expired reservations are reclaimable. Active
publication, exact revision and installation manifests pin required objects. Seal
revision payloads before the guarded RDF activation; an object-only upload is not
a published revision. Ordinary component revisions hash exact versioned serialized
bytes, not an assumed RDF canonical form. The anchor registry retains their manifest
references, and a chunked manifest may reuse unchanged immutable chunks.
Garbage collection uses a complete generation/fence, not a racy scan of one store
while another owner is activating references.

Delivery authorizes the exact selected representation and current disclosure.
Signed URLs are short-lived under an explicit revocation policy; private content
does not become public through a shared cache key. Transform jobs bind input and
erasure epochs. Erasure covers replicas, derivatives and backup/replay policy.

## Backend qualification

### First Main binding

New Work and MainVersion semantic revisions use the configured RustFS bucket
through Main's `S3ImmutableObjects` adapter. Work create and edit stage the exact
versioned payload bytes, then a manifest with the payload digest, before their
guarded graph command. Keys are `semantic/work/sha256/<digest>` in the bucket;
the graph retains the existing `urn:rezics:sha256:<digest>` reference, so a
storage location is never mistaken for an integrity claim. This namespace is
for Work semantic revisions only. Other owners require their own retention and
disclosure namespace before moving to S3.

The adapter signs each create with `If-None-Match: *` and a SHA-256 checksum
header. It reads the result back and recomputes SHA-256 before the manifest or
graph command can use the digest. An existing key is accepted only when its
bytes match. Work exact-revision and retained-effect reads verify both manifest
and payload digests through the same adapter. The previous local directory is
read only for exact legacy Work references absent from S3, and remains the
current binding for other semantic owners until their paths are migrated.

The Main process creates its configured bucket before announcing readiness.
`MAIN_S3_ENDPOINT`, `MAIN_S3_BUCKET`, `MAIN_S3_REGION`, `MAIN_S3_ACCESS_KEY` and
`MAIN_S3_SECRET_KEY` select the binding. A deployment omitting this set retains
the filesystem baseline and must be treated as an explicit migration state.
Object availability is required before a new Work graph command can run; an
object-only stage does not publish a revision.

The chosen backend must qualify conditional creation, concurrent uploads, checksum
verification, interrupted multipart cleanup, listing/GC behavior and restore.
Do not assume every S3-compatible service has identical consistency or feature
support. Storage location is chosen with the two-host deployment assessment;
durable off-host backup is separate from a second copy on the same failure domain.
