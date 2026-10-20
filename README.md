# grader-worker

The Cloudflare Worker behind the new version of [MCPGrader](https://github.com/Fra179/MCPGrader).

It replaces the Google Form that students used to submit their work. A student sends the URL of the repository to grade,
and the worker creates an SSH deploy key for it. The student gets the public half and adds it to the repository as a read-only deploy key.
The private half is stored in a Cloudflare D1 database, where the grader fetches it to clone the repository.
Students no longer generate keys or paste private keys into a form.

Each submission also gets a GitHub **push webhook** secret. Once the student adds the webhook, every push to the repository's
default branch is reported to the worker, so you know when each student last pushed and which commit is current.

Built with TypeScript, [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/).
It includes a static admin page and a Python client for the grader.

- [How it works](#how-it-works)
- [API](#api)
- [Push webhook](#push-webhook)
- [Admin authentication](#admin-authentication)
- [Admin page](#admin-page)
- [Python client](#python-client)
- [Running locally](#running-locally)
- [Deploying](#deploying)
- [Managing admin keys](#managing-admin-keys)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Security notes](#security-notes)
- [License](#license)

## How it works

```mermaid
sequenceDiagram
    actor Student
    participant W as grader-worker
    participant D1 as D1 database
    participant G as MCPGrader
    participant GH as GitHub

    Student->>W: POST /submit (assignment, repo URL, student ID, email)
    W->>W: validate, generate ECDSA P-256 key pair
    W->>D1: store submission + private key
    W-->>Student: public key (OpenSSH format) + webhook URL and secret
    Student->>GH: add the deploy key and the push webhook
    GH->>W: POST /webhook/github on every push (HMAC-signed)
    W->>D1: record last push time + commit, mark the repository as updated
    G->>W: POST /submissions (signed request)
    W->>D1: read submissions
    W-->>G: repo URLs + private keys
    G->>W: GET /updates (signed)
    W->>D1: read pending repositories and their update_id
    W-->>G: pending submissions (read-only)
    G->>GH: git clone with each private key and fix HEAD
    G->>W: POST /updates/grading (run_id per task evaluation)
    G->>W: POST /updates/graded (immutable task result)
    W->>D1: publish result and preserve pending push
    G->>W: POST /updates/acknowledged (completed run evidence)
    W->>D1: clear only matching pending update
    Student->>W: GET /leaderboard (public results)
```

- **Public endpoints:** `POST /submit` is open to anyone. It checks the input, that the repository hasn't been submitted already, and that the student hasn't already submitted this assignment.
  `POST /webhook/github` is public too, but each delivery must be signed with the submission's own webhook secret.
  `GET /leaderboard` publishes grading results and per-task grading state without admin authentication.
- **Admin endpoints:** listing and deleting submissions require a request signed with an admin key. The admin page and the Python client both sign requests.

## API

All request and response bodies are JSON. Errors look like `{"error": "message"}` with a 4xx or 5xx status.
A machine-readable description of every endpoint is in [`docs/openapi.yaml`](docs/openapi.yaml).

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| [`POST /submit`](#post-submit) | public | Submit a repository and get its deploy key |
| [`GET /submissions`, `POST /submissions`](#get-submissions-post-submissions) | admin | List submissions, including private keys |
| [`DELETE /submissions`](#delete-submissions) | admin | Delete one submission |
| [`DELETE /assignment`](#delete-assignment) | admin | Delete every submission of an assignment |
| [`GET /updates`](#get-updates) | admin | Read pending submissions without consuming them |
| [`POST /updates/grading`](UPDATES.md#post-updatesgrading) | admin | Mark one submission/task as currently grading |
| [`POST /updates/graded`](UPDATES.md#post-updatesgraded) | admin | Publish an immutable result for a task evaluation |
| [`POST /updates/cancelled`](UPDATES.md#post-updatescancelled) | admin | Abandon an evaluation; preserve its previous result |
| [`GET /grading`](UPDATES.md#get-grading) | admin | Inspect a run or discover task predecessors |
| [`POST /updates/acknowledged`](UPDATES.md#post-updatesacknowledged) | admin | Acknowledge a push using completed or unchanged-result evidence |
| [`GET /leaderboard`](UPDATES.md#get-leaderboard) | public | Latest results and per-task grading state; optional assignment filter |
| [`POST /webhook-secret`](#post-webhook-secret) | admin | Give a submission a new webhook secret |
| [`POST /webhook/github`](#push-webhook) | webhook secret | Receive GitHub push events |

### `POST /submit`

```bash
curl -X POST https://grader-api.example.com/submit \
  -H 'Content-Type: application/json' \
  -d '{
        "assignment_name": "vectorsum",
        "repo_url": "https://github.com/student/vectorsum",
        "student_id": 1234567,
        "email": "rossi.1234567@studenti.uniroma1.it"
      }'
```

| Field | Rules |
| --- | --- |
| `assignment_name` | Non-empty string, up to 512 characters |
| `repo_url` | A repository URL: `https://host/owner/repo`, `ssh://git@host/owner/repo.git` or `git@host:owner/repo.git` |
| `student_id` | Positive integer (a JSON number, not a string) |
| `email` | Must end in `@studenti.uniroma1.it`. Stored lowercased. |

**`201 Created`**

```json
{
  "id": "9f1c2a4e-5b7d-4c3e-8a21-6f0e9d8c7b6a",
  "assignment_name": "vectorsum",
  "repo_url": "https://github.com/student/vectorsum",
  "repo_ssh_url": "git@github.com:student/vectorsum.git",
  "public_key": "ecdsa-sha2-nistp256 AAAAE2VjZHNh… grader-vectorsum-1234567",
  "webhook_url": "https://grader-api.example.com/webhook/github",
  "webhook_secret": "5e983644bfe3878322c01343fae438c1…"
}
```

The student then:
1. Adds `public_key` under **Settings → Deploy keys → Add deploy key**, with write access left unchecked.
2. Adds the push webhook with `webhook_url` and `webhook_secret`, as described in [Push webhook](#push-webhook).

**Errors:**
- **`400`:** invalid input.
- **`409`:** the repository was already submitted. Repositories are compared after normalization, so `https://github.com/A/B`, `https://www.github.com/a/b.git/` and `git@github.com:a/b.git` are the same repository. The check covers all assignments.
- **`409`:** this `student_id` already submitted this assignment. Each student gets one submission per assignment; an admin can delete it to allow a new one.

### `GET /submissions`, `POST /submissions`

List submissions. All parameters are optional. `POST` takes them in the JSON body; `GET` takes them as query parameters, since GET requests can't carry a body.

| Parameter | Effect |
| --- | --- |
| `assignment_name` | Only this assignment |
| `pushed_after` | Only submissions whose `last_push` is **later** than this time. Unix seconds, or ISO 8601 **with a timezone** (`2026-10-10T18:00:00Z`, `2026-10-10T20:00:00+02:00`). Never-pushed submissions are excluded. A time without a timezone is rejected rather than guessed. |
| `order_by` | `created_at` (default) or `last_push`, ascending. Never-pushed submissions come last. |

For example, everything pushed to `vectorsum` after the deadline, oldest push first:

```json
{"assignment_name": "vectorsum", "pushed_after": "2026-10-10T23:59:59+02:00", "order_by": "last_push"}
```

or `GET /submissions?assignment_name=vectorsum&pushed_after=1791669599&order_by=last_push`. In a query string, URL-encode the `+` of a timezone offset as `%2B`.
An unencoded `+` (which arrives as a space) is accepted too.

An index on `(assignment_name, last_push)` serves this query, filter and sort, directly.

```json
{
  "submissions": [
    {
      "id": "9f1c2a4e-5b7d-4c3e-8a21-6f0e9d8c7b6a",
      "assignment_name": "vectorsum",
      "repo_url": "https://github.com/student/vectorsum",
      "repo_ssh_url": "git@github.com:student/vectorsum.git",
      "student_id": 1234567,
      "email": "rossi.1234567@studenti.uniroma1.it",
      "private_key": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
      "created_at": "2026-10-10T16:47:34.337Z",
      "webhook_seen_at": "2026-10-10T16:50:02.120Z",
      "last_push": "2026-10-10T18:33:20.000Z",
      "last_commit": "c0ffee1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b"
    }
  ]
}
```

- `repo_ssh_url` is the normalized address the grader clones.
- `private_key` is a PKCS#8 PEM key that `ssh -i` accepts directly.
- `webhook_seen_at` is the last correctly signed webhook delivery of any kind. `null` means the student hasn't set up the webhook, or set it up wrong.
- `last_push` (when the worker was notified) and `last_commit` describe the latest push to the default branch, or are `null` if none has been reported.
- The webhook secret itself is never listed. Use [`POST /webhook-secret`](#post-webhook-secret) to issue a new one.

### `DELETE /submissions`

Body `{"id": "<submission uuid>"}`. Returns `{"deleted": 1}`, or `404` if there is no such submission. Once deleted, the repository can be submitted again.

### `DELETE /assignment`

Body `{"assignment_name": "vectorsum"}`. Returns `{"deleted": n}` with the number of submissions removed, which can be 0.

### `GET /updates`

Returns `{"submissions": [...]}`: pending submissions, each once, in the same format as
[`GET /submissions`](#get-submissions-post-submissions), plus an integer `update_id`, ordered by `last_push`.
Reading does not delete anything. Each recorded push increases that submission's version and replaces its pending marker.

The grader pins each task's actual commit and starts an evaluation with a persisted `run_id`, the task's
`perf_hash`, and its `previous_run_id` (null for the first run). Scheduler retries share that run; a configuration
change or intentional rerun gets a new ID even at the same push/commit. `update_id` may be null when grading
independently of a push. The Worker assigns increasing revisions and prevents stale starts and conflicting results.

`POST /updates/graded` publishes one immutable result without acknowledging a push. Previous results remain visible
while grading. Once all applicable tasks are satisfied, `POST /updates/acknowledged` consumes only the matching
push using a map of completed run IDs. Unchanged tasks can cite older or null-provenance runs after the coordinator
compares repository, commit and fingerprint. No redundant evaluation is required. The response reason tells the
outbox to retire acknowledged/already-acknowledged/superseded entries or keep entries blocked by active runs.

Public `GET /leaderboard` exposes the current task results and grading state, including timeout status and stdout
truncation metadata. Private inspection exposes run provenance. Superseded payloads are eligible for cleanup after
90 days; compact run identities and retry digests remain. See [UPDATES.md](UPDATES.md) for the complete contract,
maintenance command, migration prerequisites, and coordinator integration requirements.

This is a breaking grading-write change requiring migration `0007` and upgraded clients. The production coordinator
in `../grader` still needs durable snapshots, a publication outbox and scheduler-token recovery before adoption.
Use `/submissions` for publication rollout first, then `/updates` to reduce repository checks.

### `POST /webhook-secret`

Body `{"id": "<submission uuid>"}`. Replaces the submission's webhook secret, for when a student lost or leaked it, and returns
`{"id", "webhook_url", "webhook_secret"}`. The old secret stops working immediately, so the student must update the webhook's secret in GitHub.
Returns `404` if there is no such submission.

## Push webhook

Every submission has its own random webhook secret (32 bytes, hex-encoded), returned by `POST /submit`.

### What the student does (once per repository)

In the repository: **Settings → Webhooks → Add webhook**:

| Field | Value |
| --- | --- |
| Payload URL | `webhook_url` from the submit response, e.g. `https://grader-api.example.com/webhook/github` |
| Content type | **`application/json`** (the default, form-encoded, is rejected) |
| Secret | `webhook_secret` from the submit response |
| Which events | Just the push event |

Or, with the [GitHub CLI](https://cli.github.com/):

```bash
gh api repos/OWNER/REPO/hooks -f name=web -F active=true -f 'events[]=push' \
  -f 'config[url]=https://grader-api.example.com/webhook/github' \
  -f 'config[content_type]=json' -f 'config[secret]=<webhook_secret>'
```

GitHub sends a `ping` right away. If it gets a green tick in the webhook's **Recent Deliveries**, the setup is correct, and the admin page
shows the time under *Webhook*. A webhook is a repository setting, so it isn't copied when a repository is forked or created from a template.

### What the worker does with a delivery

1. Finds the submission by the delivery's repository (normalized like `repo_url`, so case and `.git` don't matter).
2. Checks `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body, against **that submission's** secret. One student's secret can't update another student's repository.
3. Records the delivery time as `webhook_seen_at` (any event, including `ping`).
4. For a **push to the default branch** (the branch the grader clones), sets `last_push` to the time the worker **received** the delivery,
   and `last_commit` to the pushed commit, and marks the repository for [`GET /updates`](#get-updates).
   Pushes to other branches, tags and branch deletions are acknowledged but not recorded.

`last_push` deliberately ignores the `pushed_at` time inside the payload. The student knows their own webhook secret, so they can sign
a delivery themselves. Because the worker uses arrival time, a forged delivery can only make the recorded push *later*, never backdate it.
GitHub normally delivers within seconds of the push. A manual **Redeliver** counts as a new arrival.

Responses appear in the repository's webhook delivery log, so the messages are written for the student:

| Response | Meaning |
| --- | --- |
| `200` | Accepted. The body says whether the push was recorded and why not, e.g. `{"recorded": false, "message": "Not a push to the default branch (main)"}` |
| `401` | No signature, or it doesn't match this repository's secret |
| `404` | No submission for this repository |
| `415` | The webhook's content type isn't `application/json` |

GitHub doesn't retry failed deliveries automatically. A push that arrives while the worker is unreachable is missed until the next push,
or until someone clicks **Redeliver** in the delivery log.

## Admin authentication

The admin page has to run as a static page (for example on a Hugo site), and browser JavaScript can't present TLS client certificates.
So admin requests are signed instead, with an ECDSA P-256 key pair:

- **The private key** stays with the admin: uploaded once into the admin page (kept in that browser's localStorage), or loaded by the grader from a file.
- **The public keys** are given to the worker in the `ADMIN_PUBLIC_KEYS` secret.

Each admin request carries two headers:

| Header | Value |
| --- | --- |
| `X-Grader-Timestamp` | Current unix time in seconds |
| `X-Grader-Signature` | Base64 of the raw 64-byte `r‖s` ECDSA-SHA256 signature (the format WebCrypto produces, not DER) |

The signed message is these four lines, joined by `\n`:

```
METHOD                    e.g. POST
/path?query               exactly as requested, e.g. /submissions or /submissions?assignment_name=vectorsum
timestamp                 the X-Grader-Timestamp value
hex(sha256(body))         of the raw body bytes; the hash of an empty string when there is no body
```

The worker accepts the request if the signature verifies against any authorized public key and the timestamp is within 60 seconds of the server's clock.

| Response | Meaning |
| --- | --- |
| `401` | No signature headers, or the timestamp is too old or in the future (check the client's clock) |
| `403` | The signature doesn't match any authorized key (wrong key, or the request was modified after signing) |

The reference implementations are `canonicalRequest()` in [`src/auth.ts`](src/auth.ts), the admin page, and [`examples/client.py`](examples/client.py).

### CORS

Browsers may only call the API from the origins listed in `ALLOWED_ORIGINS` in [`wrangler.jsonc`](wrangler.jsonc) (comma-separated, e.g. `"https://example.com"`).
When it's empty, browser access is blocked. Server-side clients such as the grader aren't affected by CORS.

## Admin page

[`admin/index.html`](admin/index.html) is a single self-contained file with no build step and no dependencies. It covers every endpoint:

- Upload the admin private key. It's stored in localStorage and the page shows the public key, so you can match it against `scripts/admin-keys.sh list`.
- Make test submissions through the public endpoint.
- See each submission's webhook setup instructions (and the `gh` command) after a test submission.
- List submissions, with when each webhook last delivered and the last push and commit. Filter by assignment and by
  "pushed after" (in your local time), sort by submission time or last push, copy a private key, issue a new webhook secret, delete a submission.
- Delete a whole assignment.

The worker doesn't serve this page, and wrangler doesn't deploy it. Host it anywhere that is listed in `ALLOWED_ORIGINS`.
With Hugo, copy it to `static/admin/index.html`. The API URL is set in the page and remembered per browser.
Its default is `DEFAULT_API_URL` at the top of the script.

## Python client

[`examples/client.py`](examples/client.py) is a small client for the admin API, meant to be used by MCPGrader. It needs `cryptography` and `requests`.

```python
from datetime import datetime
from zoneinfo import ZoneInfo
from client import GraderApi

with open("keys/grader.key", "rb") as f:
    api = GraderApi("https://grader-api.example.com", f.read())

for s in api.submissions("vectorsum"):
    print(s["student_id"], s["repo_ssh_url"])   # clone with s["private_key"]

# Pushed after a deadline, oldest push first. Datetimes must be timezone-aware.
deadline = datetime(2026, 10, 10, 23, 59, 59, tzinfo=ZoneInfo("Europe/Rome"))
late = api.submissions("vectorsum", pushed_after=deadline, order_by="last_push")

api.delete_submission("9f1c2a4e-…")
api.delete_assignment("vectorsum")
new_secret = api.rotate_webhook_secret("9f1c2a4e-…")

for s in api.updates():                         # read-only; retain update_id for grading/acknowledgement
    print(s["student_id"], s["last_commit"])

# Persist run_id and this immutable start payload before sending; do not regenerate on retries.
# previous = api.grading_tasks(s["id"]).get(task, {}).get("latest_run_id")
# api.mark_grading(s["id"], task, run_id, previous, display_name, actual_commit, perf_hash,
#                  update_id=s["update_id"])
# Persist the result and outbox entry together, then publish with the same run_id:
# api.mark_graded(s["id"], task, run_id, grading)
# After all tasks are satisfied (including unchanged completed results):
# disposition = api.acknowledge(s["id"], s["update_id"], completed_run_ids_by_task)
# Retire for acknowledged/already_acknowledged/superseded; retain active_runs.
results = api.leaderboard("vectorsum")          # public; no signature required
```

It also works from the command line:

```bash
python examples/client.py https://grader-api.example.com keys/grader.key [assignment_name]
```

## Running locally

Requirements: Node.js 20 or newer, OpenSSL, and Python 3 (only to serve the admin page).

```bash
npm install

# One-time setup
cp .dev.vars.example .dev.vars          # allows the admin page's local origin
scripts/admin-keys.sh new local         # creates keys/local.key and keys/local.pub
scripts/admin-keys.sh dev-vars          # authorizes it in .dev.vars
npm run db:migrate:local                # creates the table in a local D1 (.wrangler/state)

# Then, in two terminals
npm run dev                             # API on http://localhost:8787
npm run admin                           # admin page on http://127.0.0.1:1313
```

Open http://127.0.0.1:1313, set the API URL to `http://localhost:8787` and upload `keys/local.key`. Everything works locally, admin endpoints included.
Restart `npm run dev` after changing `.dev.vars`. To reset the local data, delete `.wrangler/state` and run the migration again.

## Deploying

You need a Cloudflare account. A custom domain is optional: without one the worker can run on `*.workers.dev`.

1. **Log in:** `npx wrangler login`
2. **Create the database:** `npx wrangler d1 create grader-db`. Put the printed `database_id` in `wrangler.jsonc`.
   When wrangler offers to add the binding for you, answer **no**: the entry already exists, and the code expects the binding name `DB`.
3. **Set the hostname:** edit `routes` in `wrangler.jsonc`. To use `*.workers.dev` instead, remove `routes` and set `"workers_dev": true`.
4. **Allow the admin page's origin:** set `ALLOWED_ORIGINS` in `wrangler.jsonc`.
5. **Create the table:** `npm run db:migrate:remote`
6. **Deploy:** `npm run deploy`
7. **Authorize an admin key:** `scripts/admin-keys.sh new <name>`, then `scripts/admin-keys.sh push`.
8. **Publish the admin page** on your site and upload `keys/<name>.key` in it.

Check that it works:

```bash
curl -X POST https://<your-host>/submit -H 'Content-Type: application/json' \
  -d '{"assignment_name":"test","repo_url":"https://github.com/me/test","student_id":1,"email":"me@studenti.uniroma1.it"}'   # 201
curl https://<your-host>/submissions                                                                                         # 401
python examples/client.py https://<your-host> keys/<name>.key                                                                # lists "test"
```

To update later, run `npm run deploy`. If you added a migration, run `npm run db:migrate:remote` first.
Migration `0007` is required for independent grading runs. Stop old grading writers and drain or explicitly abandon
legacy active snapshots before applying it; the migration refuses active legacy work. Existing results are preserved.
Upgrade grader clients together with this release: grading requires run identities, and push acknowledgement now
uses its own endpoint. See [migration and recovery details](UPDATES.md#retention-deployment-and-coordinator-integration).

> **Forking?** `wrangler.jsonc` contains this deployment's `database_id` and hostname, and `admin/index.html` contains its `DEFAULT_API_URL`.
> Replace all three with your own. The database id isn't a secret (using it requires your Cloudflare credentials), but it won't work on your account.

## Managing admin keys

```bash
scripts/admin-keys.sh new <name>      # keys/<name>.key (private) + keys/<name>.pub (base64 SPKI)
scripts/admin-keys.sh list            # authorized keys
scripts/admin-keys.sh revoke <name>   # delete a key pair locally...
scripts/admin-keys.sh push            # ...and upload the remaining public keys (ADMIN_PUBLIC_KEYS); takes effect immediately
scripts/admin-keys.sh dev-vars        # write ADMIN_PUBLIC_KEYS to .dev.vars for local development
```

`keys/` is gitignored. Give each person or machine its own key (for example `laptop`, `grader-server`), so one can be revoked without affecting the others.
Pushing an empty set revokes every key.

## Testing

```bash
npm test            # Vitest inside workerd, the same runtime as production, against a real local D1
npm run typecheck
```

The tests cover validation, repository normalization and uniqueness, key generation, every admin endpoint, and signature checks:
missing or unknown keys, modified bodies, signatures replayed on another path, method or query, and stale timestamps. They also cover CORS
and the push webhook: HMAC checks (wrong secret, another student's secret, modified body), branch filtering, backdating attempts, and secret rotation.
Each test run generates its own admin key pair. GitHub Actions runs the type check and the tests on every push and pull request.

The deploy-key format was verified against OpenSSH: `ssh-keygen -y` derives the same public key from the stored private key, and `ssh-keygen -Y sign/verify` works with the pair.

## Project layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Router, admin-route marking, CORS wrapping |
| `src/submissions.ts` | Endpoint handlers, input validation, D1 queries |
| `src/auth.ts` | Request signature verification |
| `src/cors.ts` | CORS headers and preflights |
| `src/webhook.ts` | GitHub push webhook: signature check, push recording |
| `src/updates.ts` | Read-only pending updates and webhook update recording |
| `src/grading.ts` | Run lifecycle, private inspection and explicit push acknowledgement |
| `scripts/prune-grading.sql` | Optional cleanup of superseded payloads after 90 days |
| `src/leaderboard.ts` | Public leaderboard retrieval |
| `UPDATES.md` | Grading lifecycle, leaderboard API and acknowledgement contract |
| `src/deploy-key.ts` | ECDSA key pair → OpenSSH public key + PKCS#8 private key |
| `src/repo-url.ts` | Repository URL normalization, matching MCPGrader's `to_ssh_url` |
| `src/http.ts` | JSON helpers and `HttpError` |
| `migrations/` | D1 schema |
| `admin/index.html` | Admin page (not deployed by wrangler) |
| `docs/openapi.yaml` | OpenAPI description of the API |
| `examples/client.py` | Python admin client |
| `scripts/admin-keys.sh` | Admin key management |
| `test/` | Vitest tests |
| `CLAUDE.md` | Notes for AI coding agents working on this repository |

## Security notes

- **Private deploy keys are stored unencrypted in D1.** Anyone with an authorized admin key, or access to the Cloudflare account, can clone every submitted repository.
  Each key is a read-only deploy key for one repository, so it can't push or reach anything else.
- **Admin keys in the browser:** the admin page keeps its key in localStorage. Script running on the page's origin, for example through an XSS on the hosting site, could read it.
  The page renders student-supplied fields as plain text only. Host it on a site you control and revoke keys you no longer use.
- **Replay window:** a captured admin request can be replayed for up to 60 seconds. Always use HTTPS.
- **`POST /submit` doesn't verify ownership.** Anyone can submit any repository URL, and the email address isn't confirmed.
  A deploy key only works once the repository's owner adds it, so a wrong submission can't give access to someone else's repository.
  It could still block the real owner from submitting that repository until an admin deletes the submission.
- **Webhook data is only as trustworthy as the student.** Other people can't fake deliveries (each repository has its own secret),
  but the student knows their secret and can send a signed fake push for their own repository. That can't backdate `last_push`,
  which is the arrival time, but it can claim any `last_commit`. Treat `last_commit` as a hint, and grade what `git clone` actually fetches.
- **No rate limiting** is built in. Consider adding a [Cloudflare rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on `/submit`.

## License

[GPL-3.0](LICENSE), the same as [MCPGrader](https://github.com/Fra179/MCPGrader).
