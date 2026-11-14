-- Passwordless school-admin sign-in with WebAuthn passkeys.
-- Apply to BiteHub Dev first. Passkey public keys and one-time challenges
-- stay private to the Python backend; browser clients do not query these tables.

BEGIN;

CREATE TABLE bitehub_app.admin_passkeys (
  credential_id bytea PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES bitehub_app.users(id) ON DELETE CASCADE,
  credential_public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_passkeys_user_idx ON bitehub_app.admin_passkeys(user_id);

CREATE TABLE bitehub_app.webauthn_challenges (
  challenge_token_hash text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge bytea NOT NULL,
  user_id bigint REFERENCES bitehub_app.users(id) ON DELETE CASCADE,
  session_hash text,
  expires_at bigint NOT NULL
);

CREATE INDEX webauthn_challenges_expiry_idx ON bitehub_app.webauthn_challenges(expires_at);

ALTER TABLE bitehub_app.admin_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE bitehub_app.webauthn_challenges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'bitehub_app'
      AND tablename = 'admin_passkeys'
      AND policyname = 'bitehub_backend_admin_passkeys_all'
  ) THEN
    CREATE POLICY bitehub_backend_admin_passkeys_all
      ON bitehub_app.admin_passkeys
      FOR ALL TO bitehub_backend
      USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'bitehub_app'
      AND tablename = 'webauthn_challenges'
      AND policyname = 'bitehub_backend_webauthn_challenges_all'
  ) THEN
    CREATE POLICY bitehub_backend_webauthn_challenges_all
      ON bitehub_app.webauthn_challenges
      FOR ALL TO bitehub_backend
      USING (true) WITH CHECK (true);
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE bitehub_app.admin_passkeys, bitehub_app.webauthn_challenges
  TO bitehub_backend;
REVOKE ALL ON TABLE bitehub_app.admin_passkeys, bitehub_app.webauthn_challenges
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
