-- Preserve removal history on reapplications so university boards can review it.

ALTER TABLE onboarding_requests
  ADD COLUMN IF NOT EXISTS previously_removed boolean NOT NULL DEFAULT false;
