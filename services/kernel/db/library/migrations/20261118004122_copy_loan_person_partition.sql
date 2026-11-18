-- migrate:up
ALTER TABLE library.copy_loan
    DROP CONSTRAINT copy_loan_party_person_route,
    ADD CONSTRAINT copy_loan_party_person_partition CHECK (
        counterparty_person_id IS NULL OR (route >> 4) =
            ((get_byte(uuid_send(counterparty_person_id), 10) * 256 + get_byte(uuid_send(counterparty_person_id), 11)) >> 4)
    );

-- migrate:down
ALTER TABLE library.copy_loan
    DROP CONSTRAINT copy_loan_party_person_partition,
    ADD CONSTRAINT copy_loan_party_person_route CHECK (
        counterparty_person_id IS NULL OR route =
            (get_byte(uuid_send(counterparty_person_id), 10) * 256 + get_byte(uuid_send(counterparty_person_id), 11))
    );
