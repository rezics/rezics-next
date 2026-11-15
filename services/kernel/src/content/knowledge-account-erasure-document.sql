WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,:notebook_id::uuid AS notebook_id,:document_id::uuid AS document_id,
         :recorded_at::text::timestamptz AS recorded_at
), selected AS MATERIALIZED (
  SELECT document.document_id,
    document.account_erased AND document.retained_public_generation=document.lifecycle_generation
      AND content.knowledge_document_eligible(document.route,document.document_id) AS keep_public
  FROM content.knowledge_document document CROSS JOIN input i
  WHERE document.route=i.route AND document.notebook_id=i.notebook_id AND document.document_id=i.document_id
    AND NOT document.legal_hold
  FOR UPDATE OF document
)
UPDATE content.knowledge_document document
SET account_erased=true,head_revision_id=NULL,created_transaction_id=NULL,created_at=NULL,
    retained_public_generation=CASE WHEN selected.keep_public THEN document.retained_public_generation ELSE NULL END,
    current_publication_id=CASE WHEN selected.keep_public THEN document.current_publication_id ELSE NULL END,
    deleted_at=NULL,
    purge_started_at=CASE WHEN selected.keep_public THEN NULL ELSE COALESCE(document.purge_started_at,i.recorded_at) END,
    lifecycle_generation=CASE WHEN selected.keep_public OR document.purge_started_at IS NOT NULL
      THEN document.lifecycle_generation ELSE document.lifecycle_generation+1 END
FROM selected CROSS JOIN input i
WHERE document.route=i.route AND document.document_id=selected.document_id
RETURNING document.document_id;
