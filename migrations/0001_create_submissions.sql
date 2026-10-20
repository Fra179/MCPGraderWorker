CREATE TABLE submissions (
    id              TEXT PRIMARY KEY,               -- UUID v4
    assignment_name TEXT NOT NULL,
    repo_url        TEXT NOT NULL,                  -- as submitted (trimmed)
    repo_ssh_url    TEXT NOT NULL UNIQUE,           -- normalized git@host:owner/repo.git, enforces uniqueness
    student_id      INTEGER NOT NULL,
    email           TEXT NOT NULL,
    public_key      TEXT NOT NULL,                  -- OpenSSH format, added by the student as a deploy key
    private_key     TEXT NOT NULL,                  -- PKCS#8 PEM, used by the grader to clone
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_submissions_assignment_name ON submissions (assignment_name);
