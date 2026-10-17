-- Approved members are asked whether they already have an @bainsa.ai email.
-- One row per member records their answer and, for new accounts, the private
-- contact details the member's university board (or a Global President) uses
-- to send login credentials. Requests are routed to the university the member
-- belonged to when they asked, and only that board may complete them.

CREATE TABLE IF NOT EXISTS bainsa_email_requests (
  discord_user_id text PRIMARY KEY REFERENCES members(discord_user_id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('has_account', 'requested', 'created')),
  university_id bigint REFERENCES universities(id),
  first_name text,
  last_name text,
  contact_email text,
  review_message_id text,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bainsa_email_requests_details_check
    CHECK (
      status = 'has_account'
      OR (
        university_id IS NOT NULL
        AND first_name IS NOT NULL
        AND last_name IS NOT NULL
        AND contact_email IS NOT NULL
      )
    ),
  CONSTRAINT bainsa_email_requests_first_name_check
    CHECK (first_name IS NULL OR char_length(first_name) BETWEEN 1 AND 60),
  CONSTRAINT bainsa_email_requests_last_name_check
    CHECK (last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 60),
  CONSTRAINT bainsa_email_requests_contact_email_check
    CHECK (contact_email IS NULL OR char_length(contact_email) BETWEEN 3 AND 254)
);

CREATE INDEX IF NOT EXISTS bainsa_email_requests_open_idx
  ON bainsa_email_requests (university_id, created_at)
  WHERE status = 'requested';
