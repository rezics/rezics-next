-- Commercial accounting and benefit grants (SUB01-SUB03, SUB08).
-- A separate owner schema inside the Access database. Nothing in access.*
-- references these rows: an entitlement is never an Access permission grant.
-- Commands reuse access.recovery_fence (taken first, FOR SHARE) and
-- access.principal as the Account-bound payer. Access consumes effective
-- benefits only by snapshotting commerce.benefit_epoch with exact entitlement
-- reads and rechecking both at its own commit; account enforcement and
-- resource policy stay conjunctive.
CREATE SCHEMA commerce;

CREATE FUNCTION commerce.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable commerce record in %', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- Only the in-stack fake provider is admitted. Electing a live provider and its
-- currency, tax, collection and refund policy needs a later migration. The key
-- column names a secret reference; secrets stay outside this database.
-- Disabling a provider leaves its settlements to reconciliation.
CREATE TABLE commerce.payment_provider (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,62}$'),
    kind text NOT NULL CHECK (kind = 'fake'),
    callback_key_reference text NOT NULL CHECK (length(callback_key_reference) BETWEEN 1 AND 256),
    enabled boolean NOT NULL DEFAULT true
);

-- Offering identity and its current revision head. Each revision is an
-- immutable snapshot of plans, prices and benefits; a price change is a new
-- revision, so (offering_id, offering_revision, plan_key, price_key) is exact.
CREATE TABLE commerce.offering (
    id uuid PRIMARY KEY,
    seller text NOT NULL CHECK (seller ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    beneficiary_kind text NOT NULL CHECK (beneficiary_kind IN ('person', 'realm')),
    head_revision bigint NOT NULL CHECK (head_revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE commerce.offering_revision (
    offering_id uuid NOT NULL REFERENCES commerce.offering(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    -- closed stops new quotes; existing subscriptions and entitlements keep their exact revision.
    lifecycle text NOT NULL CHECK (lifecycle IN ('open', 'closed')),
    definition_digest text NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (offering_id, revision)
);
ALTER TABLE commerce.offering ADD CONSTRAINT offering_head_revision_fk
    FOREIGN KEY (id, head_revision) REFERENCES commerce.offering_revision(offering_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

-- Group semantics are fixed per group key: replaceable allows one live
-- purchased subscription per beneficiary and group, parallel allows several.
-- Changing semantics requires a new group key.
CREATE TABLE commerce.plan_group (
    offering_id uuid NOT NULL REFERENCES commerce.offering(id),
    group_key text NOT NULL CHECK (group_key ~ '^[a-z][a-z0-9-]{0,62}$'),
    semantics text NOT NULL CHECK (semantics IN ('replaceable', 'parallel')),
    PRIMARY KEY (offering_id, group_key),
    UNIQUE (offering_id, group_key, semantics)
);
CREATE TABLE commerce.plan (
    offering_id uuid NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9-]{0,62}$'),
    group_key text NOT NULL,
    -- Order inside a replaceable group; a change names its target explicitly.
    rank integer NOT NULL CHECK (rank BETWEEN 0 AND 1000),
    PRIMARY KEY (offering_id, offering_revision, plan_key),
    FOREIGN KEY (offering_id, offering_revision) REFERENCES commerce.offering_revision(offering_id, revision),
    FOREIGN KEY (offering_id, group_key) REFERENCES commerce.plan_group(offering_id, group_key)
);
CREATE INDEX plan_group_fk ON commerce.plan (offering_id, group_key);
CREATE TABLE commerce.price (
    offering_id uuid NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text NOT NULL,
    price_key text NOT NULL CHECK (price_key ~ '^[a-z][a-z0-9-]{0,62}$'),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    billing_period text NOT NULL CHECK (billing_period IN ('P1M', 'P1Y', 'once')),
    PRIMARY KEY (offering_id, offering_revision, plan_key, price_key),
    FOREIGN KEY (offering_id, offering_revision, plan_key)
        REFERENCES commerce.plan(offering_id, offering_revision, plan_key)
);
-- A plan's benefits. Level compares benefits of one key across plans; a quota
-- benefit adds an independent quota.ledger for the offering seller's scope.
CREATE TABLE commerce.plan_benefit (
    offering_id uuid NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text NOT NULL,
    benefit_key text NOT NULL CHECK (benefit_key ~ '^[a-z][a-z0-9.-]{0,126}$'),
    level integer NOT NULL CHECK (level BETWEEN 0 AND 1000),
    quota_unit text CHECK (quota_unit ~ '^[a-z][a-z0-9.-]{0,62}$'),
    quota_amount bigint CHECK (quota_amount > 0),
    PRIMARY KEY (offering_id, offering_revision, plan_key, benefit_key),
    FOREIGN KEY (offering_id, offering_revision, plan_key)
        REFERENCES commerce.plan(offering_id, offering_revision, plan_key),
    CHECK ((quota_unit IS NULL) = (quota_amount IS NULL))
);

-- Commercial state of one purchased series. Payment status lives in
-- settlements; benefits live in entitlements, never here.
CREATE TABLE commerce.subscription (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    beneficiary text NOT NULL CHECK (beneficiary ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    offering_id uuid NOT NULL,
    group_key text NOT NULL,
    group_semantics text NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text NOT NULL,
    price_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'active', 'cancelling', 'ended', 'failed')),
    generation bigint NOT NULL CHECK (generation >= 1),
    provider text NOT NULL REFERENCES commerce.payment_provider(id),
    provider_reference text CHECK (length(provider_reference) BETWEEN 1 AND 256),
    current_period_end timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider, provider_reference),
    FOREIGN KEY (offering_id, group_key, group_semantics)
        REFERENCES commerce.plan_group(offering_id, group_key, semantics),
    FOREIGN KEY (offering_id, offering_revision, plan_key, price_key)
        REFERENCES commerce.price(offering_id, offering_revision, plan_key, price_key),
    CHECK (state NOT IN ('active', 'cancelling') OR current_period_end IS NOT NULL)
);
CREATE UNIQUE INDEX subscription_replaceable_live ON commerce.subscription
    (beneficiary, offering_id, group_key)
    WHERE group_semantics = 'replaceable' AND state IN ('pending', 'active', 'cancelling');
CREATE INDEX subscription_principal ON commerce.subscription (principal_id, created_at, id);
CREATE INDEX subscription_beneficiary ON commerce.subscription (beneficiary, id);
CREATE INDEX subscription_group_fk ON commerce.subscription (offering_id, group_key, group_semantics);
CREATE INDEX subscription_price_fk ON commerce.subscription
    (offering_id, offering_revision, plan_key, price_key);

-- An exact, short-lived, single-use price and eligibility binding. The
-- eligibility snapshot names the beneficiary's benefit epoch and subscription
-- generation that the change must still match at commit.
CREATE TABLE commerce.quote (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    beneficiary text NOT NULL CHECK (beneficiary ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    operation text NOT NULL CHECK (operation IN ('purchase', 'change', 'cancel')),
    subscription_id uuid REFERENCES commerce.subscription(id),
    expected_subscription_generation bigint CHECK (expected_subscription_generation >= 1),
    offering_id uuid NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text,
    price_key text,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    eligibility jsonb NOT NULL CHECK (jsonb_typeof(eligibility) = 'object'),
    quote_digest text NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (offering_id, offering_revision) REFERENCES commerce.offering_revision(offering_id, revision),
    FOREIGN KEY (offering_id, offering_revision, plan_key, price_key)
        REFERENCES commerce.price(offering_id, offering_revision, plan_key, price_key),
    CHECK ((operation = 'purchase') = (subscription_id IS NULL)),
    CHECK ((subscription_id IS NULL) = (expected_subscription_generation IS NULL)),
    CHECK ((operation = 'cancel') = (plan_key IS NULL)),
    CHECK ((plan_key IS NULL) = (price_key IS NULL)),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX quote_principal ON commerce.quote (principal_id, created_at, id);
CREATE INDEX quote_subscription_fk ON commerce.quote (subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX quote_price_fk ON commerce.quote (offering_id, offering_revision, plan_key, price_key)
    WHERE plan_key IS NOT NULL;

-- Immutable change intent. One quote is consumed once; one change per
-- subscription generation serializes concurrent plan changes.
CREATE TABLE commerce.subscription_change (
    id uuid PRIMARY KEY,
    subscription_id uuid NOT NULL REFERENCES commerce.subscription(id),
    quote_id uuid NOT NULL UNIQUE REFERENCES commerce.quote(id),
    operation text NOT NULL CHECK (operation IN ('purchase', 'change', 'cancel')),
    base_generation bigint NOT NULL CHECK (base_generation >= 0),
    result_generation bigint NOT NULL,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (subscription_id, result_generation),
    CHECK (result_generation = base_generation + 1),
    CHECK ((operation = 'purchase') = (base_generation = 0))
);
CREATE INDEX subscription_change_receipt ON commerce.subscription_change (principal_id, idempotency_key);

-- Principal-keyed replay results, following access.org_realm_receipt and
-- access.managed_org_receipt: exact retry returns the result, changed intent conflicts.
CREATE TABLE commerce.receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('quote', 'purchase', 'change', 'cancel',
        'gift', 'revoke', 'refund', 'reconcile')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, idempotency_key)
);
ALTER TABLE commerce.subscription_change ADD CONSTRAINT subscription_change_receipt_fk
    FOREIGN KEY (principal_id, idempotency_key) REFERENCES commerce.receipt(principal_id, idempotency_key)
    DEFERRABLE INITIALLY DEFERRED;

-- One payment attempt per change. pending waits for a verified callback;
-- unknown means the provider outcome was lost and only reconciliation can
-- settle it. Terminal states never reopen.
CREATE TABLE commerce.settlement (
    id uuid PRIMARY KEY,
    change_id uuid NOT NULL UNIQUE REFERENCES commerce.subscription_change(id),
    provider text NOT NULL REFERENCES commerce.payment_provider(id),
    provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 256),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    state text NOT NULL CHECK (state IN ('pending', 'unknown', 'succeeded', 'failed', 'refunded')),
    generation bigint NOT NULL CHECK (generation >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider, provider_reference)
);
CREATE INDEX settlement_unresolved ON commerce.settlement (created_at, id)
    WHERE state IN ('pending', 'unknown');

-- Verified provider callbacks, deduplicated by provider event identity.
-- Unverified deliveries are refused before this table so they can never
-- occupy a genuine event ID. unmatched references stay reconciliation work.
CREATE TABLE commerce.provider_callback (
    provider text NOT NULL REFERENCES commerce.payment_provider(id),
    provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
    provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 256),
    event_kind text NOT NULL CHECK (event_kind IN ('payment.succeeded', 'payment.failed', 'refund.succeeded')),
    payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    disposition text NOT NULL CHECK (disposition IN ('applied', 'no-effect', 'unmatched')),
    settlement_id uuid REFERENCES commerce.settlement(id),
    settlement_generation bigint,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider, provider_event_id),
    CHECK ((disposition = 'unmatched') = (settlement_id IS NULL)),
    CHECK ((disposition = 'applied') = (settlement_generation IS NOT NULL))
);
CREATE INDEX provider_callback_unmatched ON commerce.provider_callback (provider, provider_reference)
    WHERE disposition = 'unmatched';
CREATE INDEX provider_callback_settlement ON commerce.provider_callback (settlement_id, received_at)
    WHERE settlement_id IS NOT NULL;

-- Explicit reconciliation of an unresolved settlement against a provider
-- observation. An unavailable provider records still-unknown, not failure.
CREATE TABLE commerce.reconciliation (
    id uuid PRIMARY KEY,
    operation_id text NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 200),
    settlement_id uuid NOT NULL REFERENCES commerce.settlement(id),
    base_generation bigint NOT NULL CHECK (base_generation >= 1),
    observed text NOT NULL CHECK (observed IN ('succeeded', 'failed', 'pending', 'not-found', 'unavailable')),
    observation_digest text NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('applied', 'no-change', 'still-unknown')),
    settlement_generation bigint,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((outcome = 'applied') = (settlement_generation IS NOT NULL)),
    CHECK (outcome <> 'applied' OR settlement_generation = base_generation + 1)
);
CREATE INDEX reconciliation_settlement ON commerce.reconciliation (settlement_id, created_at);

-- Immutable settlement history, one row per generation. The deferred head FK
-- makes every current settlement generation carry its audited event.
CREATE TABLE commerce.settlement_event (
    settlement_id uuid NOT NULL REFERENCES commerce.settlement(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    state text NOT NULL CHECK (state IN ('pending', 'unknown', 'succeeded', 'failed', 'refunded')),
    source text NOT NULL CHECK (source IN ('command', 'provider-callback', 'reconciliation')),
    callback_provider text,
    callback_event_id text,
    reconciliation_id uuid REFERENCES commerce.reconciliation(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (settlement_id, generation),
    FOREIGN KEY (callback_provider, callback_event_id)
        REFERENCES commerce.provider_callback(provider, provider_event_id),
    CHECK ((source = 'provider-callback') = (callback_event_id IS NOT NULL AND callback_provider IS NOT NULL)),
    CHECK ((source = 'reconciliation') = (reconciliation_id IS NOT NULL))
);
CREATE UNIQUE INDEX settlement_event_callback ON commerce.settlement_event (callback_provider, callback_event_id)
    WHERE callback_event_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_event_reconciliation ON commerce.settlement_event (reconciliation_id)
    WHERE reconciliation_id IS NOT NULL;
ALTER TABLE commerce.settlement ADD CONSTRAINT settlement_head_event_fk
    FOREIGN KEY (id, generation) REFERENCES commerce.settlement_event(settlement_id, generation)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE commerce.provider_callback ADD CONSTRAINT provider_callback_event_fk
    FOREIGN KEY (settlement_id, settlement_generation) REFERENCES commerce.settlement_event(settlement_id, generation)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE commerce.reconciliation ADD CONSTRAINT reconciliation_event_fk
    FOREIGN KEY (settlement_id, settlement_generation) REFERENCES commerce.settlement_event(settlement_id, generation)
    DEFERRABLE INITIALLY DEFERRED;

-- One independent benefit grant. Purchase and gift grants never share a row
-- or a lifecycle: a higher gift neither blocks a lower purchase nor changes its
-- payment or cancellation state. Expiry and revocation end only this grant.
CREATE TABLE commerce.entitlement (
    id uuid PRIMARY KEY,
    beneficiary text NOT NULL CHECK (beneficiary ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    source text NOT NULL CHECK (source IN ('purchase', 'gift')),
    offering_id uuid NOT NULL,
    offering_revision bigint NOT NULL,
    plan_key text NOT NULL,
    subscription_id uuid REFERENCES commerce.subscription(id),
    award_issuer text REFERENCES access.authority_subject(id),
    award_reason text CHECK (length(award_reason) BETWEEN 1 AND 128),
    replaces uuid UNIQUE REFERENCES commerce.entitlement(id),
    valid_from timestamptz NOT NULL,
    valid_until timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('active', 'ended', 'revoked')),
    generation bigint NOT NULL CHECK (generation >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (offering_id, offering_revision, plan_key)
        REFERENCES commerce.plan(offering_id, offering_revision, plan_key),
    CHECK (valid_until > valid_from),
    CHECK ((source = 'purchase') = (subscription_id IS NOT NULL)),
    CHECK ((source = 'gift') = (award_issuer IS NOT NULL)),
    CHECK ((award_issuer IS NULL) = (award_reason IS NULL))
);
CREATE INDEX entitlement_effective ON commerce.entitlement (beneficiary, valid_until, id)
    WHERE state = 'active';
CREATE INDEX entitlement_subscription ON commerce.entitlement (subscription_id, id)
    WHERE subscription_id IS NOT NULL;
CREATE INDEX entitlement_plan_fk ON commerce.entitlement (offering_id, offering_revision, plan_key);
CREATE INDEX entitlement_award_issuer_fk ON commerce.entitlement (award_issuer) WHERE award_issuer IS NOT NULL;

-- Immutable grant history. A settlement fulfills at most one grant or renewal,
-- so duplicate callbacks and reconciliation retries cannot fulfill twice.
CREATE TABLE commerce.entitlement_event (
    entitlement_id uuid NOT NULL REFERENCES commerce.entitlement(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    action text NOT NULL CHECK (action IN ('grant', 'renew', 'replace', 'expire', 'cancel', 'refund', 'revoke')),
    state text NOT NULL CHECK (state IN ('active', 'ended', 'revoked')),
    valid_until timestamptz NOT NULL,
    change_id uuid REFERENCES commerce.subscription_change(id),
    settlement_id uuid REFERENCES commerce.settlement(id),
    reason_reference text CHECK (length(reason_reference) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (entitlement_id, generation),
    CHECK ((generation = 1) = (action = 'grant')),
    CHECK (action NOT IN ('revoke', 'refund') OR reason_reference IS NOT NULL)
);
CREATE UNIQUE INDEX entitlement_event_fulfillment ON commerce.entitlement_event (settlement_id)
    WHERE settlement_id IS NOT NULL AND action IN ('grant', 'renew');
CREATE INDEX entitlement_event_change_fk ON commerce.entitlement_event (change_id) WHERE change_id IS NOT NULL;
ALTER TABLE commerce.entitlement ADD CONSTRAINT entitlement_head_event_fk
    FOREIGN KEY (id, generation) REFERENCES commerce.entitlement_event(entitlement_id, generation)
    DEFERRABLE INITIALLY DEFERRED;

-- The Access bridge fence: every entitlement insert or transition advances
-- its beneficiary's epoch in the same transaction. A decision that relied on
-- a benefit snapshots this epoch and fails closed when it has moved.
CREATE TABLE commerce.benefit_epoch (
    beneficiary text PRIMARY KEY CHECK (beneficiary ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    epoch bigint NOT NULL CHECK (epoch >= 1)
);

CREATE FUNCTION commerce.guard_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce head in % cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'offering' THEN
        IF (NEW.id, NEW.seller, NEW.beneficiary_kind, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.seller, OLD.beneficiary_kind, OLD.created_at)
            OR NEW.head_revision <> OLD.head_revision + 1 THEN
            RAISE EXCEPTION 'offering identity or revision changed illegally' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION '% generation must advance by one', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'subscription' THEN
        IF (NEW.id, NEW.principal_id, NEW.beneficiary, NEW.offering_id, NEW.group_key,
            NEW.group_semantics, NEW.provider, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.principal_id, OLD.beneficiary, OLD.offering_id, OLD.group_key,
            OLD.group_semantics, OLD.provider, OLD.created_at)
            OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
            OR OLD.state IN ('ended', 'failed') THEN
            RAISE EXCEPTION 'subscription identity changed or terminal state reopened' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'settlement' THEN
        IF (NEW.id, NEW.change_id, NEW.provider, NEW.provider_reference, NEW.amount_minor,
            NEW.currency, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.change_id, OLD.provider, OLD.provider_reference,
            OLD.amount_minor, OLD.currency, OLD.created_at)
            OR NOT ((OLD.state = 'pending' AND NEW.state IN ('unknown', 'succeeded', 'failed'))
                OR (OLD.state = 'unknown' AND NEW.state IN ('succeeded', 'failed'))
                OR (OLD.state = 'succeeded' AND NEW.state = 'refunded')) THEN
            RAISE EXCEPTION 'settlement identity changed or illegal transition' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'entitlement' THEN
        IF (NEW.id, NEW.beneficiary, NEW.source, NEW.offering_id, NEW.offering_revision, NEW.plan_key,
            NEW.subscription_id, NEW.award_issuer, NEW.award_reason, NEW.replaces, NEW.valid_from,
            NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.beneficiary, OLD.source, OLD.offering_id, OLD.offering_revision,
            OLD.plan_key, OLD.subscription_id, OLD.award_issuer, OLD.award_reason, OLD.replaces,
            OLD.valid_from, OLD.created_at)
            OR OLD.state <> 'active'
            OR (NEW.state = 'active' AND NEW.valid_until < OLD.valid_until) THEN
            -- Ended and revoked grants are terminal: no restore or retry revives them.
            RAISE EXCEPTION 'entitlement identity changed or terminal grant reopened' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER offering_head_guard BEFORE UPDATE OR DELETE ON commerce.offering
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_head();
CREATE TRIGGER subscription_head_guard BEFORE UPDATE OR DELETE ON commerce.subscription
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_head();
CREATE TRIGGER settlement_head_guard BEFORE UPDATE OR DELETE ON commerce.settlement
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_head();
CREATE TRIGGER entitlement_head_guard BEFORE UPDATE OR DELETE ON commerce.entitlement
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_head();

-- Separate branches: PL/pgSQL resolves every NEW field an expression names.
CREATE FUNCTION commerce.guard_first_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    valid boolean;
BEGIN
    IF TG_TABLE_NAME = 'offering' THEN
        valid := NEW.head_revision = 1;
    ELSIF TG_TABLE_NAME = 'entitlement' THEN
        valid := NEW.generation = 1 AND NEW.state = 'active';
    ELSIF TG_TABLE_NAME = 'settlement' THEN
        valid := NEW.generation = 1 AND NEW.state IN ('pending', 'unknown');
    ELSE
        valid := NEW.generation = 1 AND NEW.state = 'pending';
    END IF;
    IF NOT valid THEN
        RAISE EXCEPTION '% must start at its first generation and state', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER offering_first_revision BEFORE INSERT ON commerce.offering
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_first_generation();
CREATE TRIGGER subscription_first_generation BEFORE INSERT ON commerce.subscription
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_first_generation();
CREATE TRIGGER settlement_first_generation BEFORE INSERT ON commerce.settlement
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_first_generation();
CREATE TRIGGER entitlement_first_generation BEFORE INSERT ON commerce.entitlement
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_first_generation();

CREATE FUNCTION commerce.advance_benefit_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO commerce.benefit_epoch AS e (beneficiary, epoch) VALUES (NEW.beneficiary, 1)
    ON CONFLICT (beneficiary) DO UPDATE SET epoch = e.epoch + 1;
    RETURN NULL;
END $$;
CREATE TRIGGER entitlement_benefit_epoch AFTER INSERT OR UPDATE ON commerce.entitlement
    FOR EACH ROW EXECUTE FUNCTION commerce.advance_benefit_epoch();

CREATE FUNCTION commerce.guard_benefit_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.beneficiary <> OLD.beneficiary OR NEW.epoch <= OLD.epoch THEN
        RAISE EXCEPTION 'benefit epoch can only advance' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER benefit_epoch_monotone BEFORE UPDATE OR DELETE ON commerce.benefit_epoch
    FOR EACH ROW EXECUTE FUNCTION commerce.guard_benefit_epoch();

CREATE TRIGGER offering_revision_immutable BEFORE UPDATE OR DELETE ON commerce.offering_revision
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER plan_group_immutable BEFORE UPDATE OR DELETE ON commerce.plan_group
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER plan_immutable BEFORE UPDATE OR DELETE ON commerce.plan
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER price_immutable BEFORE UPDATE OR DELETE ON commerce.price
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER plan_benefit_immutable BEFORE UPDATE OR DELETE ON commerce.plan_benefit
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER quote_immutable BEFORE UPDATE OR DELETE ON commerce.quote
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER subscription_change_immutable BEFORE UPDATE OR DELETE ON commerce.subscription_change
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON commerce.receipt
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER provider_callback_immutable BEFORE UPDATE OR DELETE ON commerce.provider_callback
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER reconciliation_immutable BEFORE UPDATE OR DELETE ON commerce.reconciliation
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER settlement_event_immutable BEFORE UPDATE OR DELETE ON commerce.settlement_event
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
CREATE TRIGGER entitlement_event_immutable BEFORE UPDATE OR DELETE ON commerce.entitlement_event
    FOR EACH ROW EXECUTE FUNCTION commerce.reject_mutation();
