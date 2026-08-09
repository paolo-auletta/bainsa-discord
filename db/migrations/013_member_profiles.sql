-- Opt-in member directory profiles are authoritative in PostgreSQL. Discord
-- forum posts are a derived surface and are repaired through the durable
-- reconciliation state below.

CREATE TABLE IF NOT EXISTS member_profiles (
  discord_user_id text PRIMARY KEY REFERENCES members(discord_user_id) ON DELETE CASCADE,
  headline text NOT NULL,
  about text NOT NULL,
  "current_role" text NOT NULL,
  goals text NOT NULL,
  selected_tags text[] NOT NULL,
  current_organization text,
  location text,
  email text,
  linkedin_url text,
  research_profile_url text,
  visibility text NOT NULL DEFAULT 'published'
    CHECK (visibility IN ('published', 'hidden')),
  forum_thread_id text UNIQUE,
  forum_message_id text UNIQUE,
  published_at timestamptz NOT NULL DEFAULT now(),
  forum_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_profiles_headline_check
    CHECK (headline = btrim(headline) AND char_length(headline) BETWEEN 10 AND 80),
  CONSTRAINT member_profiles_about_check
    CHECK (about = btrim(about) AND char_length(about) BETWEEN 20 AND 300),
  CONSTRAINT member_profiles_current_role_check
    CHECK (
      "current_role" = btrim("current_role")
      AND char_length("current_role") BETWEEN 2 AND 80
    ),
  CONSTRAINT member_profiles_goals_check
    CHECK (goals = btrim(goals) AND char_length(goals) BETWEEN 10 AND 250),
  CONSTRAINT member_profiles_selected_tags_check
    CHECK (cardinality(selected_tags) BETWEEN 1 AND 4),
  CONSTRAINT member_profiles_current_organization_check
    CHECK (
      current_organization IS NULL
      OR (current_organization = btrim(current_organization)
          AND char_length(current_organization) BETWEEN 2 AND 100)
    ),
  CONSTRAINT member_profiles_location_check
    CHECK (
      location IS NULL
      OR (location = btrim(location) AND char_length(location) BETWEEN 2 AND 60)
    ),
  CONSTRAINT member_profiles_email_check
    CHECK (email IS NULL OR (email = btrim(email) AND char_length(email) <= 254)),
  CONSTRAINT member_profiles_linkedin_url_check
    CHECK (linkedin_url IS NULL OR (linkedin_url = btrim(linkedin_url) AND char_length(linkedin_url) <= 500)),
  CONSTRAINT member_profiles_research_profile_url_check
    CHECK (
      research_profile_url IS NULL
      OR (research_profile_url = btrim(research_profile_url)
          AND char_length(research_profile_url) <= 500)
    )
);

CREATE INDEX IF NOT EXISTS member_profiles_published_refresh_idx
  ON member_profiles (forum_refreshed_at, discord_user_id)
  WHERE visibility = 'published';

DROP TRIGGER IF EXISTS member_profiles_set_updated_at ON member_profiles;
CREATE TRIGGER member_profiles_set_updated_at
BEFORE UPDATE ON member_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS member_profile_reconciliation (
  discord_user_id text PRIMARY KEY REFERENCES member_profiles(discord_user_id) ON DELETE CASCADE,
  desired_generation bigint NOT NULL DEFAULT 0 CHECK (desired_generation >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_profile_reconciliation_repair_idx
  ON member_profile_reconciliation (status, requested_at, discord_user_id);

DROP TRIGGER IF EXISTS member_profile_reconciliation_set_updated_at ON member_profile_reconciliation;
CREATE TRIGGER member_profile_reconciliation_set_updated_at
BEFORE UPDATE ON member_profile_reconciliation
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
