import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneGradingPayloads } from "../src/grading";
import { BASE, call, deliver, fetchWorker, pushPayload, repository, resetDb, SHA_A, SHA_B, submission, submitRepo } from "./helpers";

beforeEach(resetDb);
const TASK = "test-cpu";
const NAME = "student-vectorsum";

function grading(overrides: Record<string, unknown> = {}) {
	return { commit_hash: SHA_A, status: "graded", error: "", stdout: "All tests passed", runtimes: [10, 20],
		avg_runtime: 15, data: { total: 2, passed: 2 }, reduction: "mean", ...overrides };
}
async function updates() {
	return (await call("GET", "/updates", undefined, "authorized")).json.submissions as any[];
}
async function setup() {
	const repo = await submitRepo();
	expect((await deliver("push", pushPayload(), repo.secret)).status).toBe(200);
	return { ...repo, update_id: (await updates())[0].update_id as number };
}
function run(id: string, overrides: Record<string, unknown> = {}) {
	return { id, task: TASK, run_id: crypto.randomUUID(), previous_run_id: null as string | null,
		update_id: null as number | null, name: NAME, commit_hash: SHA_A, perf_hash: "perf-a", ...overrides };
}
const start = (body: ReturnType<typeof run>) => call("POST", "/updates/grading", body, "authorized");
const finish = (body: ReturnType<typeof run>, result = grading()) =>
	call("POST", "/updates/graded", { id: body.id, task: body.task, run_id: body.run_id, grading: result }, "authorized");
const cancel = (body: ReturnType<typeof run>, reason = "abandoned") =>
	call("POST", "/updates/cancelled", { id: body.id, task: body.task, run_id: body.run_id, reason }, "authorized");
const inspect = (runId: string) => call("GET", `/grading?run_id=${runId}`, undefined, "authorized");
const ack = (id: string, update_id: number, runs: Record<string, string> = {}) =>
	call("POST", "/updates/acknowledged", { id, update_id, runs }, "authorized");
async function entry() {
	const response = await call("GET", "/leaderboard");
	expect(response.status).toBe(200);
	return response.json.vectorsum[0];
}

describe("grading runs", () => {
	it.each(["/updates/grading", "/updates/graded", "/updates/cancelled", "/updates/acknowledged", "/grading"])("authenticates %s", async (path) => {
		const method = path === "/grading" ? "GET" : "POST";
		expect((await call(method, path)).status).toBe(401);
		expect((await call(method, path, undefined, "unknown")).status).toBe(403);
	});

	it("grades without a push and publishes timeout and truncation metadata", async () => {
		const { id } = await submitRepo();
		const r = run(id);
		expect((await start(r)).status).toBe(201);
		expect(await entry()).toMatchObject({ is_grading: { [TASK]: true }, status: {}, grading_commit_hash: { [TASK]: SHA_A } });
		const result = grading({ status: "timeout", error: "time limit", runtimes: [], avg_runtime: 0,
			stdout: "é", stdout_truncated: true, stdout_original_bytes: 100 });
		expect((await finish(r, result)).json).toMatchObject({ saved: true, state: "completed", revision: 1 });
		expect(await entry()).toMatchObject({ status: { [TASK]: "timeout" }, avg_runtime: { [TASK]: 0 },
			stdout_truncated: { [TASK]: true }, stdout_original_bytes: { [TASK]: 100 }, is_grading: { [TASK]: false } });
		expect(await updates()).toEqual([]);
	});

	it("regrades at the same push and commit, preserving results and allocating successive revisions", async () => {
		const { id, update_id } = await setup();
		const a = run(id, { update_id });
		await start(a);
		await finish(a);
		expect(await updates()).toHaveLength(1); // finishing never acknowledges
		expect((await ack(id, update_id, { [TASK]: a.run_id })).json.reason).toBe("acknowledged");
		const b = run(id, { update_id, previous_run_id: a.run_id, perf_hash: "perf-b" });
		expect((await start(b)).json).toMatchObject({ revision: 2, state: "active" });
		expect(await entry()).toMatchObject({ avg_runtime: { [TASK]: 15 }, is_grading: { [TASK]: true } });
		await finish(b, grading({ avg_runtime: 12 }));
		const c = run(id, { update_id, previous_run_id: b.run_id, perf_hash: "perf-b" });
		expect((await start(c)).json.revision).toBe(3); // deliberate rerun with identical inputs
		expect((await entry()).avg_runtime[TASK]).toBe(12);
		expect(await updates()).toEqual([]);
	});

	it("keeps identical starts and results idempotent after later runs; changed payloads conflict", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		await start(a);
		const first = (await inspect(a.run_id)).json.started_at;
		expect((await start(a)).json).toMatchObject({ created: false, state: "active", revision: 1 });
		expect((await inspect(a.run_id)).json.started_at).toBe(first);
		await finish(a);
		const b = run(id, { previous_run_id: a.run_id });
		await start(b);
		expect((await start(a)).json).toMatchObject({ created: false, state: "completed" });
		expect((await finish(a, grading({ data: { passed: 2, total: 2 } }))).json.saved).toBe(false);
		expect((await finish(a, grading({ avg_runtime: 999 }))).status).toBe(409);
		expect((await start({ ...a, perf_hash: "changed" })).status).toBe(409);
		expect((await entry()).is_grading[TASK]).toBe(true);
		await finish(b, grading({ avg_runtime: 12 }));
		await finish(a);
		expect((await entry()).avg_runtime[TASK]).toBe(12);
	});

	it("normalizes nested object keys without changing arrays or prototype-named properties", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		await start(a);
		const data = JSON.parse('{"z":[{"b":2,"a":1},3],"__proto__":{"x":4},"a":0}');
		expect((await finish(a, grading({ data }))).status).toBe(200);
		const reordered = JSON.parse('{"a":0,"__proto__":{"x":4},"z":[{"a":1,"b":2},3]}');
		expect((await finish(a, grading({ data: reordered }))).json.saved).toBe(false);
		expect((await inspect(a.run_id)).json.grading.data).toEqual(data);
		expect((await finish(a, grading({ data: { ...data, z: [3, { a: 1, b: 2 }] } }))).status).toBe(409);
	});

	it("uses predecessor checks to reject reordered starts and globally reused IDs", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		await start(a);
		expect((await start(run(id, { previous_run_id: a.run_id }))).status).toBe(409);
		await finish(a);
		expect((await start(run(id))).status).toBe(409);
		const b = run(id, { previous_run_id: a.run_id });
		await start(b);
		await finish(b);
		expect((await start(run(id, { previous_run_id: a.run_id }))).status).toBe(409);
		const other = await submitRepo("https://github.com/student/other", 2);
		expect((await start(run(other.id, { run_id: a.run_id }))).status).toBe(409);
	});

	it("cancels only the specified run, preserves results, and retries cancelled starts safely", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		await start(a);
		await finish(a);
		expect((await cancel(a)).status).toBe(409);
		const b = run(id, { previous_run_id: a.run_id });
		await start(b);
		expect((await cancel(b)).json.cancelled).toBe(true);
		expect((await cancel(b)).json.cancelled).toBe(false);
		expect((await cancel(b, "changed reason")).status).toBe(409);
		expect((await start(b)).json.state).toBe("cancelled");
		expect((await finish(b)).status).toBe(409);
		const c = run(id, { previous_run_id: b.run_id });
		expect((await start(c)).json.revision).toBe(3);
		await cancel(b);
		expect((await entry()).is_grading[TASK]).toBe(true);
		expect((await entry()).avg_runtime[TASK]).toBe(15);
	});

	it("serializes concurrent starts and terminal transitions", async () => {
		const { id } = await submitRepo();
		const a = run(id), b = run(id);
		const starts = await Promise.all([start(a), start(b)]);
		expect(starts.map((r) => r.status).sort()).toEqual([201, 409]);
		const winner = starts[0].status === 201 ? a : b;
		const terminal = await Promise.all([finish(winner), cancel(winner)]);
		expect(terminal.map((r) => r.status).sort()).toEqual([200, 409]);
		expect((await entry()).is_grading[TASK]).toBe(false);
	});

	it("allocates one revision when the same start arrives concurrently, including UUID casing", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		const responses = await Promise.all([start(a), start({ ...a, id: id.toUpperCase(), run_id: a.run_id.toUpperCase() })]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
		expect(responses.map((r) => r.json.revision)).toEqual([1, 1]);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grading_runs").first())?.n).toBe(1);
	});

	it("rolls back run completion if publishing the projection fails", async () => {
		const { id } = await submitRepo();
		const a = run(id);
		await start(a);
		await env.DB.exec("CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON leaderboard BEGIN SELECT RAISE(ABORT, 'test failure'); END");
		try {
			expect((await finish(a)).status).toBe(500);
			expect((await inspect(a.run_id)).json.state).toBe("active");
			expect((await entry()).status).toEqual({});
		} finally { await env.DB.exec("DROP TRIGGER reject_result"); }
		expect((await finish(a)).json.saved).toBe(true);
	});

	it("inspects predecessor and active state privately and cascades deletion", async () => {
		const { id } = await submitRepo();
		expect((await call("GET", `/grading?id=${id}`, undefined, "authorized")).json).toEqual({ tasks: {} });
		const a = run(id);
		await start(a);
		const tasks = (await call("GET", `/grading?id=${id}`, undefined, "authorized")).json.tasks;
		expect(tasks[TASK]).toMatchObject({ latest_run_id: a.run_id, revision: 1, last_completed_run_id: null,
			active_run: { run_id: a.run_id, update_id: null, perf_hash: "perf-a" } });
		const response = await fetchWorker(new Request(`${BASE}/leaderboard`, { headers: { Origin: "https://site.test" } }));
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://site.test");
		for (const field of ["private_key", "email", "run_id", "perf_hash", "webhook_secret", "student_id"]) {
			expect((await entry())).not.toHaveProperty(field);
		}
		await call("DELETE", "/submissions", { id }, "authorized");
		expect((await inspect(a.run_id)).status).toBe(404);
		expect((await finish(a)).status).toBe(404);
		expect((await call("GET", "/leaderboard")).json).toEqual({});
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grading_runs").first())?.n).toBe(0);
	});

	it("preserves completed legacy results and exposes their null run identity", async () => {
		const { id } = await submitRepo();
		await env.DB.prepare("INSERT INTO leaderboard (submission_id, task, name, result_json) VALUES (?, ?, ?, ?)")
			.bind(id, TASK, NAME, JSON.stringify(grading())).run();
		expect(await entry()).toMatchObject({ avg_runtime: { [TASK]: 15 }, stdout_truncated: { [TASK]: false } });
		const a = run(id);
		expect((await start(a)).json.revision).toBe(1);
		expect((await entry()).avg_runtime[TASK]).toBe(15);
	});

	it("expires superseded payloads while preserving evidence, current output and retry digests", async () => {
		const { id, update_id } = await setup();
		const a = run(id), b = run(id, { task: "gpu" });
		await start(a); await finish(a); await start(b); await finish(b);
		const c = run(id, { previous_run_id: a.run_id });
		await start(c); await finish(c, grading({ avg_runtime: 1 }));
		expect(await pruneGradingPayloads(env)).toBe(0);
		const future = new Date(Date.now() + 91 * 86400_000);
		expect(await pruneGradingPayloads(env, future)).toBe(1);
		expect((await inspect(a.run_id)).json).toMatchObject({ state: "completed", payload_available: false, grading: null });
		expect((await inspect(c.run_id)).json.payload_available).toBe(true);
		expect((await finish(a)).json.saved).toBe(false);
		expect((await finish(a, grading({ stdout: "changed" }))).status).toBe(409);
		expect((await ack(id, update_id, { [TASK]: a.run_id, gpu: b.run_id })).json.reason).toBe("acknowledged");
	});
});

describe("push acknowledgement", () => {
	it("reuses null or older push evidence, mixes unchanged tasks and new results, and reports retries", async () => {
		const { id, secret } = await submitRepo();
		const a = run(id);
		await start(a); await finish(a);
		await deliver("push", pushPayload(), secret);
		const update = (await updates())[0].update_id;
		const gpu = run(id, { task: "gpu", update_id: update });
		await start(gpu); await finish(gpu);
		expect((await ack(id, update, { [TASK]: a.run_id, gpu: gpu.run_id })).json).toEqual({
			update_id: update, acknowledged: true, reason: "acknowledged", pending_update_id: null });
		expect((await ack(id, update, { [TASK]: a.run_id })).json.reason).toBe("already_acknowledged");
		await deliver("push", pushPayload(), secret); // identical HEAD; no new evaluation
		const next = (await updates())[0].update_id;
		expect((await ack(id, next, { [TASK]: a.run_id, gpu: gpu.run_id })).json.reason).toBe("acknowledged");
		expect((await inspect(a.run_id)).json.update_id).toBeNull();
		expect((await inspect(gpu.run_id)).json.update_id).toBe(update);
	});

	it("returns superseded even if the newer push is itself already acknowledged", async () => {
		const { id, secret, update_id } = await setup();
		const a = run(id, { update_id });
		await start(a);
		await deliver("push", pushPayload({ after: SHA_B }), secret);
		await finish(a);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).json).toMatchObject({
			reason: "superseded", acknowledged: false, pending_update_id: update_id + 1 });
		await ack(id, update_id + 1); // explicitly no applicable tasks
		expect((await ack(id, update_id, { invalid: crypto.randomUUID() })).json).toMatchObject({
			reason: "superseded", pending_update_id: null });
	});

	it("blocks on cited tasks with unrelated provenance and omitted tasks belonging to the snapshot", async () => {
		const { id, update_id } = await setup();
		const a = run(id);
		await start(a); await finish(a);
		const b = run(id, { previous_run_id: a.run_id });
		await start(b);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).json.reason).toBe("active_runs");
		await cancel(b);
		const gpu = run(id, { task: "gpu", update_id });
		await start(gpu);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).json.reason).toBe("active_runs");
		await finish(gpu);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).json.reason).toBe("acknowledged");
	});

	it("rejects invalid evidence without deleting work and permits explicit zero-task completion", async () => {
		const { id, update_id } = await setup();
		const a = run(id);
		await start(a);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).status).toBe(409);
		await cancel(a);
		expect((await ack(id, update_id, { [TASK]: a.run_id })).status).toBe(409);
		const b = run(id, { previous_run_id: a.run_id });
		await start(b); await finish(b);
		expect((await ack(id, update_id, { other: b.run_id })).status).toBe(409);
		const other = await submitRepo("https://github.com/student/other", 2);
		expect((await ack(other.id, 1, { [TASK]: b.run_id })).status).toBe(409);
		expect(await updates()).toHaveLength(1);
		expect((await ack(id, update_id)).json.reason).toBe("acknowledged");
	});

	it("never consumes a newer webhook racing an acknowledgement", async () => {
		const { id, secret, update_id } = await setup();
		await Promise.all([ack(id, update_id), deliver("push", pushPayload({ after: SHA_B }), secret)]);
		expect((await updates())[0]).toMatchObject({ update_id: update_id + 1, last_commit: SHA_B });
	});

	it("rejects another submission's evidence even when both have valid pending versions", async () => {
		const { id } = await setup();
		const a = run(id); await start(a); await finish(a);
		const other = await submitRepo("https://github.com/student/other", 2);
		await deliver("push", pushPayload({}, repository("student/other")), other.secret);
		expect((await ack(other.id, 1, { [TASK]: a.run_id })).status).toBe(409);
		expect(await updates()).toHaveLength(2);
	});

	it("preserves the marker on database failure, with the completed result unaffected", async () => {
		const { id, update_id } = await setup();
		const a = run(id); await start(a); await finish(a);
		await env.DB.exec("CREATE TRIGGER reject_ack BEFORE DELETE ON updates BEGIN SELECT RAISE(ABORT, 'test failure'); END");
		try { expect((await ack(id, update_id, { [TASK]: a.run_id })).status).toBe(500); }
		finally { await env.DB.exec("DROP TRIGGER reject_ack"); }
		expect(await updates()).toHaveLength(1);
		expect((await inspect(a.run_id)).json.state).toBe("completed");
	});
});

describe("validation and public reads", () => {
	it.each([
		{ id: "invalid" }, { run_id: "invalid" }, { previous_run_id: undefined }, { perf_hash: undefined },
		{ update_id: undefined }, { update_id: 0 }, { update_id: "1" }, { update_id: 1.5 },
		{ commit_hash: "0".repeat(40) }, { task: " " }, { name: "" },
	])("rejects malformed starts: %j", async (overrides) => {
		const { id } = await submitRepo();
		expect((await start(run(id, overrides))).status).toBe(400);
	});
	it("rejects unknown submissions and unobserved future versions", async () => {
		expect((await start(run(crypto.randomUUID()))).status).toBe(404);
		const { id } = await submitRepo();
		expect((await start(run(id, { update_id: 1 }))).status).toBe(409);
		expect((await ack(id, 1)).status).toBe(409);
		expect((await inspect(crypto.randomUUID())).status).toBe(404);
	});
	it.each([
		{ status: "queued" }, { stdout: undefined }, { runtimes: [-1] }, { runtimes: ["1"] },
		{ runtimes: [], avg_runtime: 1 }, { avg_runtime: -1 }, { avg_runtime: null }, { data: [] }, { data: null },
		{ reduction: "" }, { stdout_truncated: true }, { stdout_truncated: null }, { stdout_original_bytes: 1 },
		{ stdout_truncated: true, stdout_original_bytes: 1.5 },
	])("rejects malformed results: %j", async (overrides) => {
		const { id } = await submitRepo(); const a = run(id); await start(a);
		expect((await finish(a, grading(overrides))).status).toBe(400);
		expect((await inspect(a.run_id)).json.state).toBe("active");
	});
	it("rejects legacy completion flags and mismatched commits or tasks", async () => {
		const { id } = await submitRepo(); const a = run(id); await start(a);
		expect((await finish(a, grading({ commit_hash: SHA_B }))).status).toBe(409);
		expect((await finish({ ...a, task: "gpu" })).status).toBe(409);
		expect((await call("POST", "/updates/graded", { ...a, grading: grading(), complete: false }, "authorized")).status).toBe(400);
	});
	it("rejects nonfinite JSON numbers nested in result data without completing the run", async () => {
		const { id } = await submitRepo(); const a = run(id); await start(a);
		const body = JSON.stringify({ id, task: TASK, run_id: a.run_id, grading: grading({ data: { overflow: "OVERFLOW" } }) })
			.replace('"OVERFLOW"', '1e999');
		expect((await call("POST", "/updates/graded", body, "authorized")).status).toBe(400);
		expect((await inspect(a.run_id)).json.state).toBe("active");
	});
	it.each(["/updates/grading", "/updates/graded", "/updates/cancelled", "/updates/acknowledged"])("bounds bodies on %s", async (path) => {
		expect((await call("POST", path, { padding: "é".repeat(600_000) }, "authorized")).status).toBe(413);
	});
	it.each(["/grading", "/grading?id=bad", `/grading?id=${crypto.randomUUID()}&run_id=${crypto.randomUUID()}`,
		`/grading?id=${crypto.randomUUID()}&id=${crypto.randomUUID()}`])("rejects invalid inspection selectors: %s", async (path) => {
		expect((await call("GET", path, undefined, "authorized")).status).toBe(400);
	});
	it("filters assignment entries and removes runs when deleting an assignment", async () => {
		const { id } = await submitRepo(); const a = run(id); await start(a); await finish(a);
		const other = await call("POST", "/submit", submission({ assignment_name: "matmul", repo_url: "https://github.com/student/matmul" }));
		await start(run(other.json.id));
		expect(Object.keys((await call("GET", "/leaderboard")).json).sort()).toEqual(["matmul", "vectorsum"]);
		expect(Object.keys((await call("GET", "/leaderboard?assignment_name=matmul")).json)).toEqual(["matmul"]);
		expect((await call("GET", "/leaderboard?assignment_name=unknown")).json).toEqual({});
		await call("DELETE", "/assignment", { assignment_name: "vectorsum" }, "authorized");
		expect((await inspect(a.run_id)).status).toBe(404);
	});
});
