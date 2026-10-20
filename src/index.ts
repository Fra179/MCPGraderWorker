import { requireSignature } from "./auth";
import { preflight, withCors } from "./cors";
import { errorResponse, HttpError } from "./http";
import { deleteAssignment, deleteSubmission, listSubmissions, rotateWebhookSecret, submit } from "./submissions";
import { getUpdates } from "./updates";
import { startGrading, finishGrading, cancelGrading, inspectGrading, acknowledgeUpdate } from "./grading";
import { getLeaderboard } from "./leaderboard";
import { githubWebhook, WEBHOOK_PATH } from "./webhook";

type Handler = (request: Request, env: Env) => Promise<Response>;

interface Route {
	/** Admin routes require a request signed with an authorized admin key. */
	admin: boolean;
	handler: Handler;
}

const routes: Record<string, Record<string, Route>> = {
	"/submit": {
		POST: { admin: false, handler: submit },
	},
	"/submissions": {
		GET: { admin: true, handler: listSubmissions },
		POST: { admin: true, handler: listSubmissions },
		DELETE: { admin: true, handler: deleteSubmission },
	},
	"/assignment": {
		DELETE: { admin: true, handler: deleteAssignment },
	},
	"/updates": {
		GET: { admin: true, handler: getUpdates },
	},
	"/updates/grading": {
		POST: { admin: true, handler: startGrading },
	},
	"/updates/graded": {
		POST: { admin: true, handler: finishGrading },
	},
	"/updates/cancelled": {
		POST: { admin: true, handler: cancelGrading },
	},
	"/updates/acknowledged": {
		POST: { admin: true, handler: acknowledgeUpdate },
	},
	"/grading": {
		GET: { admin: true, handler: inspectGrading },
	},
	"/leaderboard": {
		GET: { admin: false, handler: getLeaderboard },
	},
	"/webhook-secret": {
		POST: { admin: true, handler: rotateWebhookSecret },
	},
	// Public, but every delivery must carry an HMAC made with the submission's webhook secret.
	[WEBHOOK_PATH]: {
		POST: { admin: false, handler: githubWebhook },
	},
};

async function handle(request: Request, env: Env): Promise<Response> {
	const methods = routes[new URL(request.url).pathname.replace(/\/+$/, "")];
	if (!methods) return errorResponse(404, "Not found");

	if (request.method === "OPTIONS") return preflight(request, env, Object.keys(methods));

	const route = methods[request.method];
	if (!route) {
		const response = errorResponse(405, "Method not allowed");
		response.headers.set("Allow", Object.keys(methods).join(", "));
		return response;
	}

	try {
		if (route.admin) {
			const denied = await requireSignature(request, env);
			if (denied) return denied;
		}
		return await route.handler(request, env);
	} catch (e) {
		if (e instanceof HttpError) return errorResponse(e.status, e.message);
		console.error(e);
		return errorResponse(500, "Internal server error");
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		return withCors(request, env, await handle(request, env));
	},
} satisfies ExportedHandler<Env>;
