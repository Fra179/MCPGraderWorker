import { HttpError, jsonResponse } from "./http";
import { toSshUrl } from "./repo-url";
import { recordUpdate } from "./updates";

export const WEBHOOK_PATH = "/webhook/github";

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // SHA-1, or SHA-256 object format

/** 32 random bytes as hex: the HMAC key a student puts in the GitHub webhook's "Secret" field. */
export function newWebhookSecret(): string {
	return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

interface Delivery {
	ref?: string;
	after?: string;
	deleted?: boolean;
	repository?: {
		full_name?: string;
		ssh_url?: string;
		clone_url?: string;
		html_url?: string;
		default_branch?: string;
	};
}

/**
 * POST /webhook/github (public, authenticated by HMAC): a GitHub repository webhook delivery.
 *
 * The submission is found by the delivery's repository, then the body must be signed (X-Hub-Signature-256)
 * with that submission's own webhook secret. Any signed delivery, including the `ping` GitHub sends when the
 * webhook is created, updates webhook_seen_at. Pushes to the default branch also update last_push and
 * last_commit, and mark the repository in the updates table for GET /updates.
 *
 * last_push is the time the worker received the delivery, never a time taken from the payload: the student
 * knows their own webhook secret, so they can sign a fake delivery. Using the arrival time means a forged
 * delivery can only make their last push later, never backdate it.
 *
 * Responses end up in the repository's webhook delivery log, so error messages are written for the student.
 */
export async function githubWebhook(request: Request, env: Env): Promise<Response> {
	const event = request.headers.get("X-GitHub-Event");
	if (!event) {
		throw new HttpError(400, "Not a GitHub webhook delivery (no X-GitHub-Event header)");
	}
	const signature = request.headers.get("X-Hub-Signature-256");
	if (!signature) {
		throw new HttpError(401, "Unsigned delivery: set the webhook's Secret to the one you got when submitting");
	}

	const body = new Uint8Array(await request.arrayBuffer());
	let delivery: Delivery;
	try {
		delivery = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new HttpError(415, 'Payload is not JSON: set the webhook\'s "Content type" to application/json');
	}

	const repo = delivery.repository;
	const repoSshUrl = toSshUrl(repo?.ssh_url ?? repo?.clone_url ?? repo?.html_url ?? "");
	if (!repoSshUrl) {
		throw new HttpError(400, "Delivery has no repository");
	}

	const row = await env.DB.prepare("SELECT id, webhook_secret FROM submissions WHERE repo_ssh_url = ?")
		.bind(repoSshUrl)
		.first<{ id: string; webhook_secret: string | null }>();
	if (!row) {
		throw new HttpError(404, `No submission for repository ${repo?.full_name ?? repoSshUrl}`);
	}
	if (!row.webhook_secret || !(await verifySignature(row.webhook_secret, body, signature))) {
		throw new HttpError(401, "Signature doesn't match this repository's webhook secret");
	}

	const now = new Date().toISOString();
	const markSeen = env.DB.prepare("UPDATE submissions SET webhook_seen_at = ? WHERE id = ?").bind(now, row.id);

	if (event !== "push") {
		await markSeen.run();
		return jsonResponse({ event, recorded: false, message: event === "ping" ? "Webhook is set up correctly" : "Event ignored" });
	}

	const ignored = pushIgnoredReason(delivery);
	if (ignored) {
		await markSeen.run();
		return jsonResponse({ event, recorded: false, message: ignored });
	}

	await env.DB.batch([
		env.DB.prepare("UPDATE submissions SET webhook_seen_at = ?, last_push = ?, last_commit = ?, push_version = push_version + 1 WHERE id = ?").bind(
			now,
			now,
			delivery.after,
			row.id,
		),
		recordUpdate(env, repoSshUrl),
	]);
	return jsonResponse({ event, recorded: true, last_push: now, last_commit: delivery.after });
}

/** Only pushes that move the default branch, the one the grader clones, are recorded. */
function pushIgnoredReason(delivery: Delivery): string | null {
	const defaultBranch = delivery.repository?.default_branch;
	if (!defaultBranch || delivery.ref !== `refs/heads/${defaultBranch}`) {
		return `Not a push to the default branch (${defaultBranch ?? "unknown"})`;
	}
	if (delivery.deleted || !delivery.after || !SHA_RE.test(delivery.after) || /^0+$/.test(delivery.after)) {
		return "Branch deletion";
	}
	return null;
}

async function verifySignature(secret: string, body: Uint8Array, header: string): Promise<boolean> {
	const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
	if (!match) return false;
	const signature = Uint8Array.from(match[1].match(/../g)!, (h) => parseInt(h, 16));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"verify",
	]);
	// subtle.verify compares in constant time.
	return crypto.subtle.verify("HMAC", key, signature, body);
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
