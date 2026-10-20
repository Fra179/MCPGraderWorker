import { env } from "cloudflare:test";
import { canonicalRequest } from "../src/auth";
import worker from "../src/index";

export const BASE = "https://grader.test";

/** Call the worker directly with a plain Request (the runtime type expects incoming-request cf properties). */
export function fetchWorker(request: Request): Promise<Response> {
	return worker.fetch(request as Parameters<typeof worker.fetch>[0], env);
}

export async function resetDb() {
	await env.DB.exec("DELETE FROM submissions; DELETE FROM updates");
}

/** Who signs the request: nobody, the authorized admin key, or a key the worker doesn't know. */
export type Client = "none" | "authorized" | "unknown";

const authorizedKey = crypto.subtle.importKey(
	"pkcs8",
	Uint8Array.from(atob(env.TEST_ADMIN_PRIVATE_KEY), (c) => c.charCodeAt(0)),
	{ name: "ECDSA", namedCurve: "P-256" },
	false,
	["sign"],
);
const unknownKey = crypto.subtle
	.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
	.then((pair) => (pair as CryptoKeyPair).privateKey);

/** Sign like admin/index.html does. */
export async function signedHeaders(
	client: Client,
	method: string,
	path: string,
	body: string | undefined,
	timestamp = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
	if (client === "none") return {};
	const key = client === "authorized" ? await authorizedKey : await unknownKey;
	const message = await canonicalRequest(method, path, String(timestamp), new TextEncoder().encode(body ?? ""));
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message));
	return {
		"X-Grader-Timestamp": String(timestamp),
		"X-Grader-Signature": btoa(String.fromCharCode(...signature)),
	};
}

export async function call(method: string, path: string, body?: unknown, client: Client = "none") {
	const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
	const request = new Request(BASE + path, {
		method,
		body: text,
		headers: await signedHeaders(client, method, path, text),
	});
	const response = await fetchWorker(request);
	return { status: response.status, json: (await response.json()) as any };
}

export function submission(overrides: Record<string, unknown> = {}) {
	return {
		assignment_name: "vectorsum",
		repo_url: "https://github.com/student/vectorsum",
		student_id: 1234567,
		email: "rossi.1234567@studenti.uniroma1.it",
		...overrides,
	};
}

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

/** Submit a repository and return its id and webhook secret. */
export async function submitRepo(repo_url = "https://github.com/student/vectorsum", student_id = 1234567) {
	const { json } = await call("POST", "/submit", submission({ repo_url, student_id }));
	return { id: json.id as string, secret: json.webhook_secret as string };
}

/** GitHub-shaped repository object, as found in push and ping payloads. */
export function repository(fullName = "student/vectorsum", pushedAt = Math.floor(Date.now() / 1000)) {
	return {
		full_name: fullName,
		ssh_url: `git@github.com:${fullName}.git`,
		clone_url: `https://github.com/${fullName}.git`,
		html_url: `https://github.com/${fullName}`,
		default_branch: "main",
		pushed_at: pushedAt,
	};
}

export function pushPayload(overrides: Record<string, unknown> = {}, repo = repository()) {
	return { ref: "refs/heads/main", after: SHA_A, deleted: false, repository: repo, ...overrides };
}

export async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deliver like GitHub does. `signature` overrides the computed X-Hub-Signature-256 (null = no header). */
export async function deliver(event: string, payload: unknown, secret: string, signature?: string | null) {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	const headers: Record<string, string> = { "X-GitHub-Event": event, "Content-Type": "application/json" };
	const sig = signature === undefined ? `sha256=${await hmacHex(secret, body)}` : signature;
	if (sig !== null) headers["X-Hub-Signature-256"] = sig;
	const res = await fetchWorker(new Request(`${BASE}/webhook/github`, { method: "POST", body, headers }));
	return { status: res.status, json: (await res.json()) as any };
}
