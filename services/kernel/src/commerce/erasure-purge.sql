-- Private benefit slots and entitlements share bounded native child minimization.
-- Financial disposition remains under its existing order's retained-field/custody obligation.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :ids::uuid[] AS ids
), entitlements AS (
  DELETE FROM commerce.entitlement
  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
    AND entitlement_id = ANY((SELECT ids FROM input)::uuid[])
)
DELETE FROM commerce.benefit_acquisition
WHERE route = (SELECT route FROM input) AND buyer_account_id = (SELECT account_id FROM input)
  AND slot_id = ANY((SELECT ids FROM input)::uuid[]);
