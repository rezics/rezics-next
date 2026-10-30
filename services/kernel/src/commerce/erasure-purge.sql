-- Private benefit slots and entitlements share bounded native child minimization.
-- Financial disposition remains under its existing order's retained-field/custody obligation.
WITH entitlements AS (
  DELETE FROM commerce.entitlement
  WHERE route = :route::integer AND account_id = :account_id::uuid AND entitlement_id = ANY(:ids::uuid[])
)
DELETE FROM commerce.benefit_acquisition
WHERE route = :route::integer AND buyer_account_id = :account_id::uuid AND slot_id = ANY(:ids::uuid[]);
