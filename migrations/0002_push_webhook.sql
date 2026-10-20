-- Push webhook: each submission gets its own secret for GitHub's X-Hub-Signature-256.
ALTER TABLE submissions ADD COLUMN webhook_secret   TEXT;  -- 64 hex chars; HMAC key for the GitHub webhook
ALTER TABLE submissions ADD COLUMN webhook_seen_at  TEXT;  -- last correctly signed delivery of any event (incl. ping)
ALTER TABLE submissions ADD COLUMN last_push        TEXT;  -- when the worker received the latest push to the default branch
ALTER TABLE submissions ADD COLUMN last_commit      TEXT;  -- head commit SHA of that push

-- Submissions made before this migration get a secret too; admins can hand it out or rotate it.
UPDATE submissions SET webhook_secret = lower(hex(randomblob(32))) WHERE webhook_secret IS NULL;
