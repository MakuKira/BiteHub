-- Let a verified guest order leave one review after it is completed.
-- The review still belongs to the order; guest tokens are checked by the
-- Python backend and are never stored in the feedback table.

BEGIN;

ALTER TABLE bitehub_app.feedback
  ALTER COLUMN buyer_id DROP NOT NULL;

COMMIT;
