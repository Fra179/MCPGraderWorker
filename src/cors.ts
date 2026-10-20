/**
 * CORS for browser clients (the admin page on the Hugo site). Only origins listed in ALLOWED_ORIGINS
 * (comma-separated, e.g. "https://example.com,http://localhost:1313") get CORS headers. Browsers on
 * any other origin can't read responses or send signed/JSON requests.
 */
const ALLOWED_HEADERS = "Content-Type, X-Grader-Timestamp, X-Grader-Signature";

export function allowedOrigin(request: Request, env: Env): string | null {
	const origin = request.headers.get("Origin");
	if (!origin) return null;
	const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/+$/, ""));
	return allowed.includes(origin) ? origin : null;
}

/** Answer a CORS preflight for a route that supports `methods`. */
export function preflight(request: Request, env: Env, methods: string[]): Response {
	const origin = allowedOrigin(request, env);
	if (!origin) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": methods.join(", "),
			"Access-Control-Allow-Headers": ALLOWED_HEADERS,
			"Access-Control-Max-Age": "600",
			Vary: "Origin",
		},
	});
}

export function withCors(request: Request, env: Env, response: Response): Response {
	const origin = allowedOrigin(request, env);
	const out = new Response(response.body, response);
	out.headers.append("Vary", "Origin");
	if (origin) out.headers.set("Access-Control-Allow-Origin", origin);
	return out;
}
