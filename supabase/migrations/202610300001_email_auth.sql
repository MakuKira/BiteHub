-- Private one-time tokens and email verification state for BiteHub's Python API.
-- Existing accounts remain verified; new accounts are verified by the backend.

BEGIN;

ALTER TABLE bitehub_app.users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;

CREATE TABLE bitehub_app.email_auth_tokens (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES bitehub_app.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_auth_tokens_user_purpose_idx
  ON bitehub_app.email_auth_tokens(user_id, purpose, expires_at);

ALTER TABLE bitehub_app.email_auth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY bitehub_backend_email_auth_tokens_all ON bitehub_app.email_auth_tokens
  FOR ALL TO bitehub_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bitehub_app.email_auth_tokens TO bitehub_backend;
REVOKE ALL ON TABLE bitehub_app.email_auth_tokens FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
