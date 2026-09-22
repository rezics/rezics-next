# Object storage, payloads and artifacts

## Object contract

Store immutable body payloads, original source captures, media and package artifacts
under controlled namespaces. References declare digest algorithm/bytes, media type,
size, encoding/profile and retention/disclosure domain. A locator without observed
bytes does not claim content integrity. Dedupe only across compatible rights,
privacy and erasure boundaries; object existence cannot leak another user's upload.

## Lifecycle

Upload reservation -> quarantine -> verification/transformation -> graph/reference
activation. Multipart failures and expired reservations are reclaimable. Active
publication, exact revision and installation manifests pin required objects.
Garbage collection uses a complete generation/fence, not a racy scan of one store
while another owner is activating references.

Delivery authorizes the exact selected representation and current disclosure.
Signed URLs are short-lived under an explicit revocation policy; private content
does not become public through a shared cache key. Transform jobs bind input and
erasure epochs. Erasure covers replicas, derivatives and backup/replay policy.

## Backend qualification

The chosen backend must qualify conditional creation, concurrent uploads, checksum
verification, interrupted multipart cleanup, listing/GC behavior and restore.
Do not assume every S3-compatible service has identical consistency or feature
support. Storage location is chosen with the two-host deployment assessment;
durable off-host backup is separate from a second copy on the same failure domain.
