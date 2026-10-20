import { errorResponse } from "./http";

/** How far a request's timestamp may be from the worker's clock, in seconds. Bounds replay of a captured request. */
export const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * Authorize an admin request by its ECDSA P-256 signature.
 *
 * The client signs `canonicalRequest(...)` with an admin private key (see scripts/admin-keys.sh) and sends
 * the signature in X-Grader-Signature (base64 of the raw 64-byte r||s, which is what WebCrypto produces),
 * with the unix time it signed at in X-Grader-Timestamp. The signature must verify against one of the
 * public keys in the ADMIN_PUBLIC_KEYS secret: a JSON object `{"<name>": "<base64 SPKI DER>"}`.
 *
 * Returns an error response when the request is not authorized, or null when it is.
 */
export async function requireSignature(request: Request, env: Env): Promise<Response | null> {
	const timestamp = request.headers.get("X-Grader-Timestamp");
	const signatureB64 = request.headers.get("X-Grader-Signature");
	if (!timestamp || !signatureB64) {
		return errorResponse(401, "This endpoint requires a signed request");
	}

	const seconds = Number(timestamp);
	if (!Number.isSafeInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > MAX_CLOCK_SKEW_SECONDS) {
		return errorResponse(401, `Request timestamp is more than ${MAX_CLOCK_SKEW_SECONDS}s from server time; check your clock`);
	}

	let signature: Uint8Array;
	try {
		signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
	} catch {
		return errorResponse(401, "X-Grader-Signature is not valid base64");
	}

	const body = new Uint8Array(await request.clone().arrayBuffer());
	const url = new URL(request.url);
	const message = await canonicalRequest(request.method, url.pathname + url.search, timestamp, body);

	for (const [name, key] of await adminKeys(env)) {
		if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, message)) {
			console.log(`admin request ${request.method} ${url.pathname} signed by "${name}"`);
			return null;
		}
	}
	return errorResponse(403, "Signature does not match any authorized key");
}

/**
 * The exact bytes that get signed: method, path with query, timestamp and the body's SHA-256 (hex),
 * one per line. admin/index.html builds the same string; keep the two in sync.
 */
export async function canonicalRequest(
	method: string,
	pathWithQuery: string,
	timestamp: string,
	body: Uint8Array,
): Promise<Uint8Array> {
	const bodyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return new TextEncoder().encode(`${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodyHash}`);
}

// Imported keys, cached per isolate until the secret changes.
let cachedSecret: string | undefined;
let cachedKeys: [string, CryptoKey][] = [];

async function adminKeys(env: Env): Promise<[string, CryptoKey][]> {
	const secret = env.ADMIN_PUBLIC_KEYS ?? "";
	if (secret === cachedSecret) return cachedKeys;

	const entries = secret.trim() === "" ? [] : Object.entries(JSON.parse(secret) as Record<string, string>);
	cachedKeys = await Promise.all(
		entries.map(async ([name, spki]): Promise<[string, CryptoKey]> => {
			const der = Uint8Array.from(atob(spki), (c) => c.charCodeAt(0));
			const key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
			return [name, key];
		}),
	);
	cachedSecret = secret;
	return cachedKeys;
}
