export function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export function errorResponse(status: number, error: string): Response {
	return jsonResponse({ error }, status);
}

/** Thrown by request parsing and validation; turned into a 4xx JSON response by the router. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/**
 * Read the request body as a JSON object. An empty body yields `{}` when `optional` is set,
 * so endpoints with only optional fields can be called without a body.
 */
export async function readJsonObject(request: Request, optional = false, maxBytes?: number): Promise<Record<string, unknown>> {
	const text = maxBytes === undefined ? await request.text() : await readLimitedText(request, maxBytes);
	if (text.trim() === "") {
		if (optional) return {};
		throw new HttpError(400, "Request body must be a JSON object");
	}

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new HttpError(400, "Request body is not valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpError(400, "Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

/** Bound JSON parsing memory and reject oversized grading requests. */
async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
	if (Number(request.headers.get("Content-Length")) > maxBytes) {
		throw new HttpError(413, "Request body exceeds 1 MiB");
	}
	const reader = request.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				void reader.cancel();
				throw new HttpError(413, "Request body exceeds 1 MiB");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
