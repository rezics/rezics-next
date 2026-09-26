-- 010 armed a durable send marker but left every unacknowledged send pending:
-- a peer that withheld its receipt could keep strong closure and Access
-- recovery reopening pending indefinitely. The pinned Bun WebSocket cannot
-- recall an offered frame. Its terminate() discards only process-buffered
-- bytes and closes with FIN, so a paused peer still reads every byte already
-- handed to the kernel. These terminal states record that process send
-- boundary; none of them claims a recall.
--
-- withheld     The arming session proved, with its receipt challenge, that it
--              never offered the frame (for example the native position moved
--              after the arm).
-- unconfirmed  The frame may have been offered and no receipt arrived. The
--              owning session records it after closing its socket. Any process
--              may record it once 30 seconds have elapsed since the arm, beyond
--              the session's offer and receipt deadlines. It counts as a
--              possible delivery before the terminal transition, never an abort.
--
-- An armed row therefore stays pending only while its session can still hand
-- bytes to the socket, or until a sweep observes the elapsed send window.
ALTER TABLE access.search_read_lease
    DROP CONSTRAINT search_read_lease_state_check,
    DROP CONSTRAINT search_read_lease_state,
    DROP CONSTRAINT search_read_terminal_send,
    ADD COLUMN settled_by text;

ALTER TABLE access.search_read_lease
    ADD CONSTRAINT search_read_lease_state_check CHECK (state IN ('admitted', 'delivering',
      'delivered', 'aborted', 'expired', 'withheld', 'unconfirmed')),
    ADD CONSTRAINT search_read_lease_state CHECK (
      (state = 'admitted' AND delivery_started_at IS NULL AND finished_at IS NULL)
      OR (state = 'delivering' AND delivery_started_at IS NOT NULL AND finished_at IS NULL)
      OR (state IN ('delivered', 'aborted', 'expired', 'withheld', 'unconfirmed')
        AND finished_at IS NOT NULL)
    ),
    ADD CONSTRAINT search_read_settlement CHECK (
      (settled_by IS NULL AND state NOT IN ('withheld', 'unconfirmed'))
      OR (settled_by = 'session' AND state IN ('withheld', 'unconfirmed'))
      OR (settled_by = 'window' AND state = 'unconfirmed'
        AND finished_at - send_started_at >= interval '30 seconds')
    ),
    -- Keep 010's upgrade rule: historical delivered rows without a marker stay
    -- intact, while every new or updated row must satisfy this CHECK.
    ADD CONSTRAINT search_read_terminal_send CHECK (
      (state IN ('admitted', 'aborted', 'expired') AND send_started_at IS NULL)
      OR state = 'delivering'
      OR (state IN ('delivered', 'withheld', 'unconfirmed') AND send_started_at IS NOT NULL)
    ) NOT VALID;

CREATE INDEX search_read_armed_window ON access.search_read_lease (send_started_at, id)
    WHERE state = 'delivering' AND send_started_at IS NOT NULL;
CREATE INDEX search_read_unarmed_expiry ON access.search_read_lease (expires_at, id)
    WHERE state = 'delivering' AND send_started_at IS NULL;
