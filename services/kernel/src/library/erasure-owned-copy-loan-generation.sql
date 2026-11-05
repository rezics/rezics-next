DELETE FROM library.copy_loan_generation
WHERE route=:route AND account_id=:account_id
RETURNING true AS removed;
