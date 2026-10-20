import { generateDeployKey } from "./deploy-key";
import { HttpError, jsonResponse, readJsonObject } from "./http";
import { toSshUrl } from "./repo-url";
import { newWebhookSecret, WEBHOOK_PATH } from "./webhook";

const EMAIL_RE = /^[^\s@]+@studenti\.uniroma1\.it$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 512;

/** Columns returned to admin clients by /submissions. The webhook secret is left out: rotate it to get a new one. */
export const ADMIN_COLUMNS = `id, assignment_name, repo_url, repo_ssh_url, student_id, email, private_key, created_at,
	webhook_seen_at, last_push, last_commit`;

/**
 * POST /submit (public): store a submission and hand back what the student must add to the repository:
 * the deploy key's public half, and the URL and secret for the push webhook.
 */
export async function submit(request: Request, env: Env): Promise<Response> {
	const body = await readJsonObject(request);

	const assignmentName = requireText(body, "assignment_name");
	const repoUrl = requireText(body, "repo_url");
	const repoSshUrl = toSshUrl(repoUrl);
	if (repoSshUrl === null) {
		throw new HttpError(400, "repo_url must be a repository URL such as https://github.com/owner/repo");
	}

	const studentId = body.student_id;
	if (typeof studentId !== "number" || !Number.isSafeInteger(studentId) || studentId <= 0) {
		throw new HttpError(400, "student_id must be a positive integer");
	}

	const email = requireText(body, "email").toLowerCase();
	if (!EMAIL_RE.test(email)) {
		throw new HttpError(400, "email must be an @studenti.uniroma1.it address");
	}

	const id = crypto.randomUUID();
	const webhookSecret = newWebhookSecret();
	const key = await generateDeployKey(`grader-${assignmentName.replace(/\s+/g, "-")}-${studentId}`);

	try {
		await env.DB.prepare(
			`INSERT INTO submissions
			   (id, assignment_name, repo_url, repo_ssh_url, student_id, email, public_key, private_key, webhook_secret)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(id, assignmentName, repoUrl, repoSshUrl, studentId, email, key.publicKey, key.privateKey, webhookSecret)
			.run();
	} catch (e) {
		if (String(e).includes("UNIQUE constraint failed: submissions.repo_ssh_url")) {
			throw new HttpError(409, "This repository has already been submitted");
		}
		if (String(e).includes("UNIQUE constraint failed: submissions.assignment_name, submissions.student_id")) {
			throw new HttpError(409, "This student has already submitted this assignment");
		}
		throw e;
	}

	return jsonResponse(
		{
			id,
			assignment_name: assignmentName,
			repo_url: repoUrl,
			repo_ssh_url: repoSshUrl,
			public_key: key.publicKey,
			webhook_url: webhookUrl(request),
			webhook_secret: webhookSecret,
		},
		201,
	);
}

/**
 * GET/POST /submissions (signed): list submissions. All parameters are optional:
 * - assignment_name: only this assignment
 * - pushed_after: only submissions whose last_push is later than this (ISO 8601 with a timezone, or unix seconds)
 * - order_by: "created_at" (default) or "last_push", ascending; never-pushed rows come last
 * GET takes them as query parameters because GET requests can't carry a body.
 * The (assignment_name, last_push) index serves the assignment + pushed_after + order_by=last_push case directly.
 */
export async function listSubmissions(request: Request, env: Env): Promise<Response> {
	const params: Record<string, unknown> =
		request.method === "GET"
			? Object.fromEntries(new URL(request.url).searchParams)
			: await readJsonObject(request, true);

	const where: string[] = [];
	const binds: unknown[] = [];

	const assignmentName = params.assignment_name;
	if (assignmentName !== undefined && assignmentName !== null && assignmentName !== "") {
		if (typeof assignmentName !== "string") {
			throw new HttpError(400, "assignment_name must be a string");
		}
		where.push("assignment_name = ?");
		binds.push(assignmentName.trim());
	}

	const filterByPush = params.pushed_after !== undefined && params.pushed_after !== null && params.pushed_after !== "";
	if (filterByPush) {
		where.push("last_push > ?");
		binds.push(toStoredTimestamp(params.pushed_after, "pushed_after"));
	}

	const orderBy = params.order_by ?? "created_at";
	if (orderBy !== "created_at" && orderBy !== "last_push") {
		throw new HttpError(400, 'order_by must be "created_at" or "last_push"');
	}

	// With pushed_after there are no NULL last_push rows, and a plain "ORDER BY last_push" is read straight from
	// the (assignment_name, last_push) index with no sort step (checked with EXPLAIN QUERY PLAN).
	const order =
		orderBy === "created_at" ? "created_at" : filterByPush ? "last_push" : "last_push NULLS LAST, created_at";
	const sql = `SELECT ${ADMIN_COLUMNS} FROM submissions
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY ${order}`;
	const { results } = await env.DB.prepare(sql).bind(...binds).all();
	return jsonResponse({ submissions: results });
}

/**
 * Convert a client timestamp to the exact format last_push is stored in (Date.toISOString(): UTC, milliseconds),
 * because SQLite compares the TEXT column as text: "…T18:00:00Z" would compare wrongly against "…T18:00:00.000Z".
 * Accepts unix seconds (number or digit string) or ISO 8601 with an explicit timezone; a string without a timezone
 * is rejected rather than guessed.
 */
function toStoredTimestamp(value: unknown, field: string): string {
	let date: Date | null = null;
	// An unencoded "+02:00" in a query string arrives as " 02:00".
	if (typeof value === "string") value = value.trim().replace(/ (\d\d:?\d\d)$/, "+$1");
	if (typeof value === "number" && Number.isFinite(value)) {
		date = new Date(value * 1000);
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		date = new Date(Number(value.trim()) * 1000);
	} else if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/i.test(value.trim())) {
		date = new Date(value.trim());
	}
	if (!date || Number.isNaN(date.getTime())) {
		throw new HttpError(
			400,
			`${field} must be unix seconds or an ISO 8601 time with a timezone, e.g. 2026-10-10T18:00:00Z or 2026-10-10T20:00:00+02:00`,
		);
	}
	return date.toISOString();
}

/** DELETE /submissions (signed): delete one submission by its UUID. */
export async function deleteSubmission(request: Request, env: Env): Promise<Response> {
	const id = requireUuid(await readJsonObject(request));
	const { meta } = await env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id).run();
	if (meta.changes === 0) {
		throw new HttpError(404, "Submission not found");
	}
	return jsonResponse({ deleted: meta.changes });
}

/** DELETE /assignment (signed): delete every submission of an assignment. */
export async function deleteAssignment(request: Request, env: Env): Promise<Response> {
	const assignmentName = requireText(await readJsonObject(request), "assignment_name");
	const { meta } = await env.DB.prepare("DELETE FROM submissions WHERE assignment_name = ?")
		.bind(assignmentName)
		.run();
	return jsonResponse({ deleted: meta.changes });
}

/** POST /webhook-secret (signed): replace a submission's webhook secret, e.g. after a student lost or leaked it. */
export async function rotateWebhookSecret(request: Request, env: Env): Promise<Response> {
	const id = requireUuid(await readJsonObject(request));
	const secret = newWebhookSecret();
	const { meta } = await env.DB.prepare("UPDATE submissions SET webhook_secret = ? WHERE id = ?").bind(secret, id).run();
	if (meta.changes === 0) {
		throw new HttpError(404, "Submission not found");
	}
	return jsonResponse({ id, webhook_url: webhookUrl(request), webhook_secret: secret });
}

function webhookUrl(request: Request): string {
	return new URL(WEBHOOK_PATH, request.url).href;
}

function requireUuid(body: Record<string, unknown>): string {
	const id = requireText(body, "id");
	if (!UUID_RE.test(id)) {
		throw new HttpError(400, "id must be a UUID");
	}
	return id.toLowerCase();
}

function requireText(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new HttpError(400, `${field} is required and must be a non-empty string`);
	}
	if (value.length > MAX_TEXT_LENGTH) {
		throw new HttpError(400, `${field} must be at most ${MAX_TEXT_LENGTH} characters`);
	}
	return value.trim();
}
