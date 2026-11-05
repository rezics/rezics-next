-- Local positive evidence only. No branch proves foreign/shared absence.
-- Subject-home subject_offer_reference copies are minimal offer-key locators. Their source
-- ownership is the indexed creator offer range below; foreign cleanup/custody remains pending.
-- Each probe is anchored to this account's native home and indexed ownership prefix.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT
  EXISTS (SELECT 1 FROM commerce.offer WHERE route = i.route AND creator_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.purchase_order WHERE route = i.route AND buyer_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.money_observation WHERE route = i.route AND buyer_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.benefit_acquisition WHERE route = i.route AND buyer_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.entitlement WHERE route = i.route AND account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.royalty_line WHERE route = i.route AND creator_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.payout_statement WHERE route = i.route AND creator_account_id = i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.creator_sale WHERE route = i.route AND creator_account_id = i.account_id)
  AS "hasData"
FROM input i;
