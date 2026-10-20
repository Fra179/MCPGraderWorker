import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call, deliver, pushPayload, repository, resetDb, SHA_B, submitRepo } from "./helpers";

beforeEach(resetDb);

async function push(secret: string, fullName = "student/vectorsum", overrides: Record<string, unknown> = {}) {
	const { status } = await deliver("push", pushPayload(overrides, repository(fullName)), secret);
	expect(status).toBe(200);
}

async function pending(): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT repo_ssh_url FROM updates ORDER BY repo_ssh_url").all<{ repo_ssh_url: string }>();
	return results.map((r) => r.repo_ssh_url);
}

describe("POST /webhook/github → updates table", () => {
	it("marks the repository of each recorded push, once however many pushes", async () => {
		const { secret } = await submitRepo("https://github.com/Student/VectorSum");
		await push(secret, "Student/VectorSum");
		await push(secret, "Student/VectorSum", { after: SHA_B });
		expect(await pending()).toEqual(["git@github.com:student/vectorsum.git"]);
	});

	it("marks nothing for pings, other branches or rejected deliveries", async () => {
		const { secret } = await submitRepo();
		await deliver("ping", { repository: repository() }, secret);
		await push(secret, "student/vectorsum", { ref: "refs/heads/feature" });
		await deliver("push", pushPayload(), "wrong-secret");
		expect(await pending()).toEqual([]);
	});
});

describe("GET /updates", () => {
	it("is admin only", async () => {
		expect((await call("GET", "/updates")).status).toBe(401);
		expect((await call("GET", "/updates", undefined, "unknown")).status).toBe(403);
	});

	it("returns each pushed submission once, in the /submissions row format, without consuming them", async () => {
		const a = await submitRepo("https://github.com/student/a", 1);
		const b = await submitRepo("https://github.com/student/b", 2);
		await submitRepo("https://github.com/student/never-pushed", 3);
		await push(a.secret, "student/a");
		await push(b.secret, "student/b");
		await push(a.secret, "student/a", { after: SHA_B });

		const { status, json } = await call("GET", "/updates", undefined, "authorized");
		expect(status).toBe(200);
		expect(json.submissions.map((s: any) => s.id).sort()).toEqual([a.id, b.id].sort());

		const listed = (await call("GET", "/submissions", undefined, "authorized")).json.submissions;
		const listedA = listed.find((s: any) => s.id === a.id);
		expect(json.submissions.find((s: any) => s.id === a.id)).toEqual({ ...listedA, update_id: 2 });
		expect(listedA.last_commit).toBe(SHA_B);

		expect(await pending()).toHaveLength(2);
		expect((await call("GET", "/updates", undefined, "authorized")).json).toEqual(json);
	});

	it("refreshes the update token for each push after a fetch", async () => {
		const { id, secret } = await submitRepo();
		await push(secret);
		await call("GET", "/updates", undefined, "authorized");
		await push(secret, "student/vectorsum", { after: SHA_B });

		const { json } = await call("GET", "/updates", undefined, "authorized");
		expect(json.submissions.map((s: any) => [s.id, s.last_commit, s.update_id])).toEqual([[id, SHA_B, 2]]);
	});

	it("drops updates for submissions deleted since the push", async () => {
		const { id, secret } = await submitRepo();
		await push(secret);
		await call("DELETE", "/submissions", { id }, "authorized");

		const { json } = await call("GET", "/updates", undefined, "authorized");
		expect(json.submissions).toEqual([]);
		expect(await pending()).toEqual([]);
	});
});
