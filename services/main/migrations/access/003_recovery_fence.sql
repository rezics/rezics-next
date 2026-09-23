-- One global Access pause for isolated recovery. Every ordinary Access admission,
-- claim, outcome and disclosure transaction takes this row before scope locks.
CREATE TABLE access.recovery_fence (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    open boolean NOT NULL DEFAULT true,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
INSERT INTO access.recovery_fence (id) VALUES (true);
