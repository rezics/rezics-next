-- Include sealed history and malformed scope assignments of this fixed action.
CREATE INDEX admission_verification_assessment_history
    ON access.admission (id)
    WHERE action = 'verification.claim-assess';
