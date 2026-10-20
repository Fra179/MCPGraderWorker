import { HttpError, jsonResponse, readJsonObject } from "./http";

const MAX_BODY_BYTES = 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface Run {
	run_id: string;
	submission_id: string;
	task: string;
	revision: number;
	previous_run_id: string | null;
	update_id: number | null;
	name: string;
	commit_hash: string;
	perf_hash: string;
	state: "active" | "completed" | "cancelled";
	started_at: string;
	terminal_at: string | null;
	cancellation_reason: string | null;
	result_json: string | null;
	result_digest: string | null;
	superseded_at: string | null;
}

/** Allocate a revision only when the caller's predecessor is still current and no run is active. */
export async function startGrading(request: Request, env: Env): Promise<Response> {
	const body = await readJsonObject(request, false, MAX_BODY_BYTES);
	const { id, task, runId } = identity(body);
	const previous = body.previous_run_id === null ? null : uuid(body.previous_run_id, "previous_run_id");
	const update = body.update_id === null ? null : updateId(body.update_id);
	const name = text(body.name, "name");
	const commit = commitHash(body.commit_hash);
	const perf = text(body.perf_hash, "perf_hash");
	const [inserted, selected, submission] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare(`INSERT INTO grading_runs
			(run_id, submission_id, task, revision, previous_run_id, update_id, name, commit_hash, perf_hash, started_at)
			SELECT ?, s.id, ?, COALESCE(l.last_revision, 0) + 1, ?, ?, ?, ?, ?, ?
			FROM submissions s LEFT JOIN leaderboard l ON l.submission_id = s.id AND l.task = ?
			WHERE s.id = ? AND (? IS NULL OR s.push_version >= ?)
			AND l.latest_run_id IS ? AND l.active_run_id IS NULL
			AND NOT EXISTS (SELECT 1 FROM grading_runs WHERE run_id = ?)
			RETURNING run_id`)
			.bind(runId, task, previous, update, name, commit, perf, new Date().toISOString(), task, id, update, update, previous, runId),
		env.DB.prepare("SELECT * FROM grading_runs WHERE run_id = ?").bind(runId),
		env.DB.prepare("SELECT push_version FROM submissions WHERE id = ?").bind(id),
	]);
	const version = submission.results[0]?.push_version as number | undefined;
	if (version === undefined) throw new HttpError(404, "Submission not found");
	const run = selected.results[0] as unknown as Run | undefined;
	if (!run) throw new HttpError(409, update !== null && update > version
		? "update_id does not identify a recorded push" : "Stale previous_run_id or a task run is already active");
	if (run.submission_id !== id || run.task !== task || run.previous_run_id !== previous || run.update_id !== update
		|| run.name !== name || run.commit_hash !== commit || run.perf_hash !== perf) {
		throw new HttpError(409, "run_id was already used with a different start payload");
	}
	const created = inserted.results.length > 0;
	return jsonResponse({ run_id: runId, revision: run.revision, state: run.state, created }, created ? 201 : 200);
}

/** A terminal result is immutable, even after its large historical payload has expired. */
export async function finishGrading(request: Request, env: Env): Promise<Response> {
	const body = await readJsonObject(request, false, MAX_BODY_BYTES);
	const { id, task, runId } = identity(body);
	if ("complete" in body) throw new HttpError(400, "complete is no longer supported; use /updates/acknowledged");
	const grading = validateGrading(body.grading);
	const serialized = canonicalJson(grading);
	const digest = await sha256(serialized);
	const [saved, selected, submission] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare(`UPDATE grading_runs SET state = 'completed', result_json = ?, result_digest = ?, terminal_at = ?
			WHERE run_id = ? AND submission_id = ? AND task = ? AND state = 'active' AND commit_hash = ?
			AND EXISTS (SELECT 1 FROM leaderboard WHERE submission_id = ? AND task = ?
				AND active_run_id = ? AND latest_run_id = ?) RETURNING run_id`)
			.bind(serialized, digest, new Date().toISOString(), runId, id, task, grading.commit_hash, id, task, runId, runId),
		env.DB.prepare("SELECT * FROM grading_runs WHERE run_id = ?").bind(runId),
		env.DB.prepare("SELECT id FROM submissions WHERE id = ?").bind(id),
	]);
	const run = requireRun(selected, submission, id, task);
	if (run.state !== "completed" || run.result_digest !== digest) {
		throw new HttpError(409, "Run is cancelled, commit differs, or its completed result is immutable");
	}
	return jsonResponse({ run_id: runId, revision: run.revision, state: run.state, saved: saved.results.length > 0 });
}

/** Abandon an evaluation; this does not cancel a scheduler job. */
export async function cancelGrading(request: Request, env: Env): Promise<Response> {
	const body = await readJsonObject(request, false, MAX_BODY_BYTES);
	const { id, task, runId } = identity(body);
	const reason = text(body.reason, "reason");
	const [cancelled, selected, submission] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare(`UPDATE grading_runs SET state = 'cancelled', cancellation_reason = ?, terminal_at = ?
			WHERE run_id = ? AND submission_id = ? AND task = ? AND state = 'active'
			AND EXISTS (SELECT 1 FROM leaderboard WHERE submission_id = ? AND task = ? AND active_run_id = ?)
			RETURNING run_id`).bind(reason, new Date().toISOString(), runId, id, task, id, task, runId),
		env.DB.prepare("SELECT * FROM grading_runs WHERE run_id = ?").bind(runId),
		env.DB.prepare("SELECT id FROM submissions WHERE id = ?").bind(id),
	]);
	const run = requireRun(selected, submission, id, task);
	if (run.state !== "cancelled" || run.cancellation_reason !== reason) {
		throw new HttpError(409, "Run is completed or was cancelled with a different reason");
	}
	return jsonResponse({ run_id: runId, state: run.state, cancelled: cancelled.results.length > 0 });
}

export async function inspectGrading(request: Request, env: Env): Promise<Response> {
	const params = new URL(request.url).searchParams;
	if (params.getAll("id").length + params.getAll("run_id").length !== 1) {
		throw new HttpError(400, "Supply exactly one id or run_id query selector");
	}
	if (params.has("run_id")) {
		const run = await env.DB.prepare("SELECT * FROM grading_runs WHERE run_id = ?")
			.bind(uuid(params.get("run_id"), "run_id")).first<Run>();
		if (!run) throw new HttpError(404, "Run not found");
		return privateResponse(publicRun(run));
	}
	const id = uuid(params.get("id"), "id");
	const [submission, rows] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare("SELECT id FROM submissions WHERE id = ?").bind(id),
		env.DB.prepare(`SELECT l.task, l.latest_run_id, l.last_revision AS revision, l.result_run_id AS last_completed_run_id,
			r.run_id, r.submission_id, r.revision AS active_revision, r.previous_run_id, r.update_id, r.name,
			r.commit_hash, r.perf_hash, r.state, r.started_at
			FROM leaderboard l LEFT JOIN grading_runs r ON r.run_id = l.active_run_id
			WHERE l.submission_id = ? ORDER BY l.task`).bind(id),
	]);
	if (!submission.results.length) throw new HttpError(404, "Submission not found");
	const tasks: Record<string, unknown> = Object.create(null);
	for (const row of rows.results) {
		tasks[row.task as string] = {
			latest_run_id: row.latest_run_id, revision: row.revision, last_completed_run_id: row.last_completed_run_id,
			active_run: row.run_id === null ? null : {
				run_id: row.run_id, id, task: row.task, revision: row.active_revision,
				previous_run_id: row.previous_run_id, update_id: row.update_id, name: row.name,
				commit_hash: row.commit_hash, perf_hash: row.perf_hash, state: row.state, started_at: row.started_at,
			},
		};
	}
	return privateResponse({ tasks });
}

/** The coordinator declares the task set and verifies unchanged inputs; the Worker checks evidence ownership. */
export async function acknowledgeUpdate(request: Request, env: Env): Promise<Response> {
	const body = await readJsonObject(request, false, MAX_BODY_BYTES);
	const id = uuid(body.id, "id");
	const update = updateId(body.update_id);
	if (!isObject(body.runs)) throw new HttpError(400, "runs must be a task-to-run-id object");
	const evidence: Record<string, string> = Object.create(null);
	for (const [task, run] of Object.entries(body.runs)) {
		const normalized = text(task, "runs task");
		if (Object.hasOwn(evidence, normalized)) throw new HttpError(400, "runs contains duplicate normalized tasks");
		evidence[normalized] = uuid(run, "runs run_id");
	}
	const runs = JSON.stringify(evidence);
	// One JSON bind avoids D1's parameter limit for snapshots with many tasks.
	const valid = `NOT EXISTS (SELECT 1 FROM json_each(?1) e LEFT JOIN grading_runs r ON r.run_id = e.value
		WHERE r.run_id IS NULL OR r.submission_id != ?2 OR r.task != e.key OR r.state != 'completed')`;
	const active = `EXISTS (SELECT 1 FROM grading_runs r WHERE r.submission_id = ?2 AND r.state = 'active'
		AND (r.update_id = ?3 OR r.task IN (SELECT key FROM json_each(?1))))`;
	const [decision, deleted, pending] = await env.DB.batch<Record<string, unknown>>([
		env.DB.prepare(`SELECT CASE
			WHEN s.push_version < ?3 THEN 'future'
			WHEN s.push_version > ?3 THEN 'superseded'
			WHEN u.update_id IS NULL THEN 'already_acknowledged'
			WHEN NOT (${valid}) THEN 'invalid_evidence'
			WHEN ${active} THEN 'active_runs'
			ELSE 'acknowledged' END AS reason
			FROM submissions s LEFT JOIN updates u ON u.repo_ssh_url = s.repo_ssh_url WHERE s.id = ?2`)
			.bind(runs, id, update),
		env.DB.prepare(`DELETE FROM updates WHERE update_id = ?3
			AND repo_ssh_url = (SELECT repo_ssh_url FROM submissions WHERE id = ?2 AND push_version = ?3)
			AND ${valid} AND NOT (${active}) RETURNING update_id`).bind(runs, id, update),
		env.DB.prepare(`SELECT update_id FROM updates WHERE repo_ssh_url =
			(SELECT repo_ssh_url FROM submissions WHERE id = ?)`).bind(id),
	]);
	const reason = decision.results[0]?.reason;
	if (reason === undefined) throw new HttpError(404, "Submission not found");
	if (reason === "future") throw new HttpError(409, "update_id does not identify a recorded push");
	if (reason === "invalid_evidence") throw new HttpError(409, "Every evidence run must be completed and belong to its submission/task");
	return jsonResponse({ update_id: update, acknowledged: deleted.results.length > 0, reason,
		pending_update_id: pending.results[0]?.update_id ?? null });
}

/** Optional maintenance: preserve current payloads and all compact retry/evidence records. */
export async function pruneGradingPayloads(env: Env, now = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
	const result = await env.DB.prepare(`UPDATE grading_runs SET result_json = NULL
		WHERE result_json IS NOT NULL AND superseded_at <= ?
		AND NOT EXISTS (SELECT 1 FROM leaderboard WHERE result_run_id = grading_runs.run_id)`).bind(cutoff).run();
	return result.meta.changes;
}

function requireRun(selected: D1Result, submission: D1Result, id: string, task: string): Run {
	if (!submission.results.length) throw new HttpError(404, "Submission not found");
	const run = selected.results[0] as unknown as Run | undefined;
	if (!run) throw new HttpError(404, "Run not found");
	if (run.submission_id !== id || run.task !== task) throw new HttpError(409, "Run belongs to another submission or task");
	return run;
}

function publicRun(run: Run) {
	const { submission_id, result_json, ...metadata } = run;
	return { ...metadata, id: submission_id, payload_available: result_json !== null,
		grading: result_json === null ? null : JSON.parse(result_json) };
}

function privateResponse(body: unknown): Response {
	const response = jsonResponse(body);
	response.headers.set("Cache-Control", "no-store");
	return response;
}

function identity(body: Record<string, unknown>) {
	return { id: uuid(body.id, "id"), task: text(body.task, "task"), runId: uuid(body.run_id, "run_id") };
}

function uuid(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
		throw new HttpError(400, `${field} must be a UUID`);
	}
	return value.toLowerCase();
}

function updateId(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new HttpError(400, "update_id must be a positive integer");
	}
	return value;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
		throw new HttpError(400, `${field} must be a non-empty string of at most 512 characters`);
	}
	return value.trim();
}

function commitHash(value: unknown): string {
	if (typeof value !== "string" || !SHA_RE.test(value) || /^0+$/.test(value)) {
		throw new HttpError(400, "commit_hash must be a full lowercase SHA-1 or SHA-256 commit hash");
	}
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGrading(value: unknown) {
	if (!isObject(value)) throw new HttpError(400, "grading must be an object");
	const commit = commitHash(value.commit_hash);
	if (!["graded", "error", "timeout"].includes(value.status as string)) {
		throw new HttpError(400, 'grading.status must be "graded", "error" or "timeout"');
	}
	if (typeof value.error !== "string" || typeof value.stdout !== "string") {
		throw new HttpError(400, "grading.error and grading.stdout must be strings");
	}
	const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
	if (!Array.isArray(value.runtimes) || !value.runtimes.every(nonnegative) || !nonnegative(value.avg_runtime)
		|| (value.runtimes.length === 0 && value.avg_runtime !== 0)) {
		throw new HttpError(400, "Runtimes and average must be finite nonnegative numbers; empty runtimes require a zero average");
	}
	if (!isObject(value.data)) throw new HttpError(400, "grading.data must be an object");
	const bytes = new TextEncoder().encode(value.stdout).byteLength;
	const truncated = value.stdout_truncated ?? false;
	const originalBytes = value.stdout_original_bytes ?? bytes;
	if (typeof truncated !== "boolean" || !Number.isSafeInteger(originalBytes) || (originalBytes as number) < bytes
		|| (truncated ? (originalBytes as number) <= bytes : originalBytes !== bytes)
		|| ("stdout_truncated" in value && value.stdout_truncated === null)
		|| ("stdout_original_bytes" in value && value.stdout_original_bytes === null)) {
		throw new HttpError(400, "Invalid stdout truncation metadata or UTF-8 byte count");
	}
	return { commit_hash: commit, status: value.status, error: value.error, stdout: value.stdout,
		runtimes: value.runtimes, avg_runtime: value.avg_runtime, data: value.data,
		reduction: text(value.reduction, "grading.reduction"), stdout_truncated: truncated, stdout_original_bytes: originalBytes };
}

/** Iterative traversal handles deeply nested, body-size-limited JSON without exhausting the JS stack. */
function canonicalJson(value: unknown): string {
	const output: string[] = [];
	const stack: Array<{ value: unknown } | { literal: string }> = [{ value }];
	while (stack.length) {
		const item = stack.pop()!;
		if ("literal" in item) { output.push(item.literal); continue; }
		const v = item.value;
		if (v !== null && typeof v === "object") {
			const array = Array.isArray(v);
			const entries = array ? v.map((entry, index) => [String(index), entry] as const) : Object.keys(v).sort().map((key) => [key, (v as Record<string, unknown>)[key]] as const);
			output.push(array ? "[" : "{");
			stack.push({ literal: array ? "]" : "}" });
			for (let i = entries.length - 1; i >= 0; i--) {
				const [key, entry] = entries[i];
				stack.push({ value: entry });
				if (!array) stack.push({ literal: JSON.stringify(key) + ":" });
				if (i > 0) stack.push({ literal: "," });
			}
		} else {
			if (typeof v === "number" && !Number.isFinite(v)) throw new HttpError(400, "Result numbers must be finite");
			output.push(JSON.stringify(v));
		}
	}
	return output.join("");
}

async function sha256(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
