-- migrate:up
-- Removing the last occurrence of a current-progress group deleted it after decrementing the row to zero. The table's
-- occurrences > 0 check rejected that intermediate row, so any progress record that replaced the last occurrence
-- failed. The last occurrence is now deleted directly; the scope counters move exactly as before.
CREATE OR REPLACE FUNCTION library.reading_insights_current_progress_apply(
  p_route integer,p_account_id uuid,p_scope text,p_meaning jsonb,p_current numeric,p_total numeric,p_delta integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE present boolean; remaining bigint;
BEGIN
  IF p_delta NOT IN (-1,1) THEN RAISE EXCEPTION 'Invalid current-progress delta'; END IF;
  IF p_delta=1 THEN
    SELECT EXISTS(SELECT 1 FROM library.reading_insights_current_progress_group
      WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning) INTO present;
    IF present THEN
      UPDATE library.reading_insights_current_progress_group SET
        occurrences=occurrences+1,
        current_known=current_known+(p_current IS NOT NULL)::integer,
        current_sum=current_sum+COALESCE(p_current,0),
        total_known=total_known+(p_total IS NOT NULL)::integer,
        total_sum=total_sum+COALESCE(p_total,0)
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning;
    ELSE
      INSERT INTO library.reading_insights_current_progress_group
        (route,account_id,scope,meaning,occurrences,current_known,current_sum,total_known,total_sum)
        VALUES(p_route,p_account_id,p_scope,p_meaning,1,(p_current IS NOT NULL)::integer,
          COALESCE(p_current,0),(p_total IS NOT NULL)::integer,COALESCE(p_total,0));
      UPDATE library.reading_insights_current_progress_scope SET group_count=group_count+1
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
    END IF;
  ELSE
    SELECT occurrences INTO remaining FROM library.reading_insights_current_progress_group
      WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning FOR UPDATE;
    IF remaining IS NULL THEN RAISE EXCEPTION 'Missing current-progress receiver group'; END IF;
    IF remaining=1 THEN
      DELETE FROM library.reading_insights_current_progress_group
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning;
      UPDATE library.reading_insights_current_progress_scope SET group_count=group_count-1
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
    ELSE
      UPDATE library.reading_insights_current_progress_group SET
        occurrences=occurrences-1,
        current_known=current_known-(p_current IS NOT NULL)::integer,
        current_sum=current_sum-COALESCE(p_current,0),
        total_known=total_known-(p_total IS NOT NULL)::integer,
        total_sum=total_sum-COALESCE(p_total,0)
        WHERE route=p_route AND account_id=p_account_id AND scope=p_scope AND meaning=p_meaning;
    END IF;
  END IF;
  UPDATE library.reading_insights_current_progress_scope SET
    occurrences=occurrences+p_delta,
    current_known=current_known+p_delta*(p_current IS NOT NULL)::integer,
    total_known=total_known+p_delta*(p_total IS NOT NULL)::integer
    WHERE route=p_route AND account_id=p_account_id AND scope=p_scope;
END $$;

-- migrate:down
-- Forward only: the previous body fails when it removes a group's last occurrence, so restoring it would reintroduce that
-- failure.
