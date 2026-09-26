-- Private completeness witnesses. Graph revision manifests remain the value owner.
-- Pre-migration contexts need explicit reconstruction before new aggregate reads.
CREATE TABLE access.rating_aggregate_context (
    context text PRIMARY KEY,
    realm text NOT NULL,
    revision text NOT NULL UNIQUE,
    admission_id uuid NOT NULL UNIQUE REFERENCES access.admission(id)
);
CREATE TABLE access.rating_aggregate_head (
    context text NOT NULL REFERENCES access.rating_aggregate_context(context),
    main_version text NOT NULL,
    slot text NOT NULL CHECK (slot ~ '^urn:rezics:rating-slot:[0-9a-f]{64}$'),
    work text NOT NULL,
    observation text NOT NULL UNIQUE,
    revision text NOT NULL UNIQUE,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    admission_id uuid NOT NULL UNIQUE REFERENCES access.admission(id),
    original_admission_id uuid NOT NULL REFERENCES access.admission(id),
    PRIMARY KEY (context, main_version, slot)
);
CREATE INDEX rating_aggregate_head_principal ON access.rating_aggregate_head(principal_id);
CREATE INDEX rating_aggregate_head_original ON access.rating_aggregate_head(original_admission_id);
