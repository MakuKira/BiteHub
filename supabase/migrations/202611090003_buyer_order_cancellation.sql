-- Allow a customer to cancel or edit an order before the stall accepts it.
-- Cancellation continues to use the existing declined status; this flag
-- distinguishes a customer cancellation from a stall decline.

BEGIN;

ALTER TABLE bitehub_app.orders
  ADD COLUMN IF NOT EXISTS buyer_cancelled boolean NOT NULL DEFAULT false;

COMMIT;
