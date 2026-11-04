-- migrate:up
CREATE TABLE library.copy_loan_generation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    generation integer NOT NULL DEFAULT 1,
    CONSTRAINT copy_loan_generation_account_route CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
    CONSTRAINT copy_loan_generation_positive CHECK (generation BETWEEN 1 AND 2147483647),
    CONSTRAINT copy_loan_generation_pkey PRIMARY KEY (route, account_id)
);

CREATE TABLE library.copy_loan (
    route integer NOT NULL,
    loan_id uuid NOT NULL,
    account_id uuid NOT NULL,
    copy_id uuid NOT NULL,
    direction text NOT NULL,
    counterparty_kind text NOT NULL,
    counterparty_name text,
    counterparty_person_id uuid,
    started_on date NOT NULL,
    due_on date,
    returned_on date,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT copy_loan_route_account CHECK (route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))),
    CONSTRAINT copy_loan_route_copy CHECK (route = ((get_byte(uuid_send(copy_id), 10) * 256) + get_byte(uuid_send(copy_id), 11))),
    CONSTRAINT copy_loan_route_id CHECK (route = ((get_byte(uuid_send(loan_id), 10) * 256) + get_byte(uuid_send(loan_id), 11))),
    CONSTRAINT copy_loan_direction CHECK (direction IN ('lent', 'borrowed')),
    CONSTRAINT copy_loan_party_kind CHECK (counterparty_kind IN ('name', 'person')),
    CONSTRAINT copy_loan_party_shape CHECK (
      (counterparty_kind = 'name' AND counterparty_name IS NOT NULL AND counterparty_person_id IS NULL AND char_length(counterparty_name) BETWEEN 1 AND 300)
      OR (counterparty_kind = 'person' AND counterparty_name IS NULL AND counterparty_person_id IS NOT NULL)
    ),
    CONSTRAINT copy_loan_party_person_route CHECK (counterparty_person_id IS NULL OR route = ((get_byte(uuid_send(counterparty_person_id), 10) * 256) + get_byte(uuid_send(counterparty_person_id), 11))),
    CONSTRAINT copy_loan_due_after_start CHECK (due_on IS NULL OR due_on >= started_on),
    CONSTRAINT copy_loan_revision_positive CHECK (revision BETWEEN 1 AND 2147483647),
    CONSTRAINT copy_loan_pkey PRIMARY KEY (route, loan_id)
);

COMMENT ON TABLE library.copy_loan IS 'Private owner loan history. copy_id is intentionally not a foreign key so returned history survives copy deletion; terminal owner erasure removes loan and generation rows in bounded pages.';
COMMENT ON COLUMN library.copy_loan.counterparty_name IS 'Exact private name text; it is never normalized or matched to a person.';

CREATE UNIQUE INDEX copy_loan_one_open_per_copy ON library.copy_loan (route, account_id, copy_id) WHERE returned_on IS NULL;
CREATE INDEX copy_loan_open_due_seek ON library.copy_loan (route, account_id, due_on ASC NULLS LAST, loan_id ASC) WHERE returned_on IS NULL;
CREATE INDEX copy_loan_history_seek ON library.copy_loan (route, account_id, returned_on DESC, loan_id DESC) WHERE returned_on IS NOT NULL;
CREATE INDEX copy_loan_owner_purge_seek ON library.copy_loan (route, account_id, loan_id);

-- migrate:down
DROP INDEX library.copy_loan_owner_purge_seek;
DROP INDEX library.copy_loan_history_seek;
DROP INDEX library.copy_loan_open_due_seek;
DROP INDEX library.copy_loan_one_open_per_copy;
DROP TABLE library.copy_loan;
DROP TABLE library.copy_loan_generation;
