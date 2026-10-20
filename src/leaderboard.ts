import { HttpError, jsonResponse } from "./http";

const RESULT_FIELDS = ["commit_hash", "status", "error", "stdout", "runtimes", "avg_runtime", "data", "reduction", "stdout_truncated", "stdout_original_bytes"] as const;

interface LeaderboardRow {
	submission_id: string;
	assignment_name: string;
	task: string;
	name: string;
	result_json: string | null;
	active_run_id: string | null;
	active_commit_hash: string | null;
	grading_started_at: string | null;
}

interface Entry {
	name: string;
	tasks: string[];
	[field: string]: string | string[] | Record<string, unknown>;
}

/** Public leaderboard: grading data only, never submission credentials or student contact details. */
export async function getLeaderboard(request: Request, env: Env): Promise<Response> {
	const assignment = new URL(request.url).searchParams.get("assignment_name");
	if (assignment !== null && (assignment.trim() === "" || assignment.length > 512)) {
		throw new HttpError(400, "assignment_name must be a non-empty string of at most 512 characters");
	}
	const query = env.DB.prepare(`SELECT l.submission_id, s.assignment_name, l.task, l.name,
		l.result_json, l.active_run_id, l.active_commit_hash, l.grading_started_at
		FROM leaderboard l JOIN submissions s ON s.id = l.submission_id
		${assignment === null ? "" : "WHERE s.assignment_name = ?"}
		ORDER BY s.assignment_name, s.created_at, s.id, l.task`);
	const { results } = await (assignment === null ? query : query.bind(assignment)).all<LeaderboardRow>();
	const grouped: Record<string, Entry[]> = Object.create(null);
	const submissions = new Map<string, Entry>();
	for (const row of results) {
		let entry = submissions.get(row.submission_id);
		if (!entry) {
			// The first task in lexical order supplies the repository display name.
			entry = { name: row.name, tasks: [] };
			for (const field of [...RESULT_FIELDS, "is_grading", "grading_started_at", "grading_commit_hash"]) {
				entry[field] = Object.create(null) as Record<string, unknown>;
			}
			submissions.set(row.submission_id, entry);
			(grouped[row.assignment_name] ??= []).push(entry);
		}
		entry.tasks.push(row.task);
		if (row.result_json !== null) {
			const result = JSON.parse(row.result_json) as Record<string, unknown>;
			// Completed results from migration 0006 predate truncation metadata.
			result.stdout_truncated ??= false;
			result.stdout_original_bytes ??= new TextEncoder().encode(result.stdout as string).byteLength;
			for (const field of RESULT_FIELDS) {
				(entry[field] as Record<string, unknown>)[row.task] = result[field];
			}
		}
		(entry.is_grading as Record<string, unknown>)[row.task] = row.active_run_id !== null;
		(entry.grading_started_at as Record<string, unknown>)[row.task] = row.grading_started_at;
		(entry.grading_commit_hash as Record<string, unknown>)[row.task] = row.active_commit_hash;
	}
	const response = jsonResponse(grouped);
	// Active grading state should not be hidden by a browser or intermediary cache.
	response.headers.set("Cache-Control", "no-store");
	return response;
}
