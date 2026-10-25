-- One temporal primary-key probe per mounted group. Other groups and closed history stay unread.
SELECT group_name AS "group"
FROM unnest(:groups::text[]) AS wanted(group_name)
WHERE (
  SELECT count(*)
  FROM access.exposure_opening opening
  WHERE opening."group" = wanted.group_name
    AND opening.valid @> :at::timestamptz
) > 0;
