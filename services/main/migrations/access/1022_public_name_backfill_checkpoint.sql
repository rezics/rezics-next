CREATE TABLE access.public_name_backfill_checkpoint (
    data_epoch text NOT NULL,
    profile text NOT NULL,
    after_resource text NOT NULL DEFAULT '',
    complete boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (data_epoch, profile)
);
