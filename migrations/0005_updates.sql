-- Repositories pushed to since the last GET /updates. The primary key dedupes: many pushes, one row.
-- No foreign key: a row whose submission was deleted just matches nothing and is cleared on the next fetch.
CREATE TABLE updates (repo_ssh_url TEXT PRIMARY KEY);
