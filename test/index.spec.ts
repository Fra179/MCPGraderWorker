import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { toSshUrl } from "../src/repo-url";
import { BASE, call, fetchWorker, resetDb, signedHeaders, submission } from "./helpers";

beforeEach(resetDb);

describe("POST /submit", () => {
	it("stores a submission and returns its id and OpenSSH public key", async () => {
		const { status, json } = await call("POST", "/submit", submission());
		expect(status).toBe(201);
		expect(json.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(json.public_key).toMatch(/^ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYA\S+ grader-vectorsum-1234567$/);
		expect(json.private_key).toBeUndefined();
		expect(json.repo_ssh_url).toBe("git@github.com:student/vectorsum.git");
		expect(json.webhook_url).toBe(`${BASE}/webhook/github`);
		expect(json.webhook_secret).toMatch(/^[0-9a-f]{64}$/);

		const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(json.id).first<any>();
		expect(row).toMatchObject({
			assignment_name: "vectorsum",
			repo_ssh_url: "git@github.com:student/vectorsum.git",
			student_id: 1234567,
			public_key: json.public_key,
		});
		expect(row.private_key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
		expect(row.webhook_secret).toBe(json.webhook_secret);
	});

	it("gives every submission a distinct id and key", async () => {
		const a = await call("POST", "/submit", submission({ repo_url: "https://github.com/a/repo", student_id: 1 }));
		const b = await call("POST", "/submit", submission({ repo_url: "https://github.com/b/repo", student_id: 2 }));
		expect(a.json.id).not.toBe(b.json.id);
		expect(a.json.public_key).not.toBe(b.json.public_key);
	});

	it("rejects a repository that was already submitted, in any spelling", async () => {
		expect((await call("POST", "/submit", submission())).status).toBe(201);
		for (const repo_url of [
			"https://github.com/student/vectorsum",
			"https://www.github.com/Student/VectorSum.git/",
			"git@github.com:student/vectorsum.git",
		]) {
			const { status, json } = await call("POST", "/submit", submission({ repo_url, student_id: 7654321 }));
			expect(status).toBe(409);
			expect(json.error).toMatch(/already been submitted/);
		}
	});

	it("rejects a second repository from the same student for the same assignment", async () => {
		expect((await call("POST", "/submit", submission())).status).toBe(201);
		const { status, json } = await call("POST", "/submit", submission({ repo_url: "https://github.com/student/other" }));
		expect(status).toBe(409);
		expect(json.error).toMatch(/already submitted this assignment/);

		// Another assignment is fine.
		const other = submission({ assignment_name: "matmul", repo_url: "https://github.com/student/other" });
		expect((await call("POST", "/submit", other)).status).toBe(201);
	});

	it.each([
		["missing assignment_name", { assignment_name: undefined }],
		["blank assignment_name", { assignment_name: "  " }],
		["invalid repo_url", { repo_url: "not a url" }],
		["repo_url without owner/repo", { repo_url: "https://github.com/student" }],
		["ftp repo_url", { repo_url: "ftp://github.com/student/repo" }],
		["string student_id", { student_id: "1234567" }],
		["fractional student_id", { student_id: 12.5 }],
		["negative student_id", { student_id: -1 }],
		["foreign email", { email: "rossi@gmail.com" }],
		["staff email", { email: "rossi@uniroma1.it" }],
		["lookalike email domain", { email: "rossi@studenti.uniroma1.it.evil.com" }],
	])("rejects %s", async (_, overrides) => {
		const { status, json } = await call("POST", "/submit", submission(overrides));
		expect(status).toBe(400);
		expect(json.error).toBeTypeOf("string");
	});

	it("rejects malformed JSON and non-object bodies", async () => {
		expect((await call("POST", "/submit", "{nope")).status).toBe(400);
		expect((await call("POST", "/submit", [1, 2])).status).toBe(400);
		expect((await call("POST", "/submit")).status).toBe(400);
	});

});

describe("admin authentication", () => {
	it.each([
		["GET", "/submissions"],
		["POST", "/submissions"],
		["DELETE", "/submissions"],
		["DELETE", "/assignment"],
		["POST", "/webhook-secret"],
	])("%s %s requires a signature from an authorized key", async (method, path) => {
		const body = method === "GET" ? undefined : {};
		expect((await call(method, path, body, "none")).status).toBe(401);
		expect((await call(method, path, body, "unknown")).status).toBe(403);
	});

	it("accepts a request signed by an authorized key", async () => {
		expect((await call("GET", "/submissions", undefined, "authorized")).status).toBe(200);
		expect((await call("GET", "/submissions?assignment_name=x", undefined, "authorized")).status).toBe(200);
	});

	async function send(method: string, path: string, body: string | undefined, headers: Record<string, string>) {
		const res = await fetchWorker(new Request(BASE + path, { method, body, headers }));
		return res.status;
	}

	it("rejects a signed request whose body was changed", async () => {
		const headers = await signedHeaders("authorized", "DELETE", "/assignment", '{"assignment_name":"a1"}');
		expect(await send("DELETE", "/assignment", '{"assignment_name":"a2"}', headers)).toBe(403);
	});

	it("rejects a signature replayed on another path, method or query", async () => {
		const headers = await signedHeaders("authorized", "GET", "/submissions?assignment_name=a1", undefined);
		expect(await send("GET", "/submissions?assignment_name=a2", undefined, headers)).toBe(403);
		expect(await send("POST", "/submissions?assignment_name=a1", undefined, headers)).toBe(403);
	});

	it("rejects stale or future timestamps", async () => {
		const now = Math.floor(Date.now() / 1000);
		for (const ts of [now - 120, now + 120]) {
			const headers = await signedHeaders("authorized", "GET", "/submissions", undefined, ts);
			expect(await send("GET", "/submissions", undefined, headers)).toBe(401);
		}
	});

	it("rejects a malformed signature", async () => {
		const headers = { "X-Grader-Timestamp": String(Math.floor(Date.now() / 1000)), "X-Grader-Signature": "%%%" };
		expect(await send("GET", "/submissions", undefined, headers)).toBe(401);
	});

	it("does not protect /submit", async () => {
		expect((await call("POST", "/submit", submission(), "none")).status).toBe(201);
	});
});

describe("CORS", () => {
	it("answers preflights from allowed origins with the auth headers allowed", async () => {
		const res = await fetchWorker(
			new Request(BASE + "/submissions", {
				method: "OPTIONS",
				headers: { Origin: "https://site.test", "Access-Control-Request-Method": "DELETE" },
			})
		);
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://site.test");
		expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Grader-Signature");
	});

	it("refuses preflights from other origins", async () => {
		const res = await fetchWorker(
			new Request(BASE + "/submissions", { method: "OPTIONS", headers: { Origin: "https://evil.test" } })
		);
		expect(res.status).toBe(403);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("adds the allow-origin header to responses, including errors, only for allowed origins", async () => {
		const ok = await fetchWorker(new Request(BASE + "/submissions", { headers: { Origin: "http://localhost:1313" } }));
		expect(ok.status).toBe(401);
		expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:1313");

		const other = await fetchWorker(new Request(BASE + "/submissions", { headers: { Origin: "https://evil.test" } }));
		expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("listing submissions", () => {
	async function seed() {
		await call("POST", "/submit", submission({ assignment_name: "a1", repo_url: "https://github.com/x/one", student_id: 1 }));
		await call("POST", "/submit", submission({ assignment_name: "a1", repo_url: "https://github.com/x/two", student_id: 2 }));
		await call("POST", "/submit", submission({ assignment_name: "a2", repo_url: "https://github.com/x/three", student_id: 3 }));
	}

	it("returns every submission with its private key when no assignment_name is given", async () => {
		await seed();
		const { status, json } = await call("POST", "/submissions", undefined, "authorized");
		expect(status).toBe(200);
		expect(json.submissions).toHaveLength(3);
		expect(Object.keys(json.submissions[0]).sort()).toEqual(
			[
				"id", "assignment_name", "repo_url", "repo_ssh_url", "student_id", "email", "private_key", "created_at",
				"webhook_seen_at", "last_push", "last_commit",
			].sort(),
		);
		expect(json.submissions[0].private_key).toMatch(/BEGIN PRIVATE KEY/);
	});

	it("filters by assignment_name in the body (POST) or query string (GET)", async () => {
		await seed();
		const post = await call("POST", "/submissions", { assignment_name: "a1" }, "authorized");
		expect(post.json.submissions.map((s: any) => s.repo_url).sort()).toEqual([
			"https://github.com/x/one",
			"https://github.com/x/two",
		]);
		const get = await call("GET", "/submissions?assignment_name=a2", undefined, "authorized");
		expect(get.json.submissions).toHaveLength(1);
		expect((await call("POST", "/submissions", { assignment_name: "nope" }, "authorized")).json.submissions).toEqual([]);
	});

	it("rejects a non-string assignment_name", async () => {
		expect((await call("POST", "/submissions", { assignment_name: 3 }, "authorized")).status).toBe(400);
	});
});

describe("filtering and sorting by last push", () => {
	/** Submissions for a1 (pushed at 10:00 and 12:00, and one never pushed) and a2 (pushed at 11:00). */
	async function seed() {
		const ids: Record<string, string> = {};
		for (const [name, assignment, lastPush] of [
			["early", "a1", "2026-10-10T10:00:00.000Z"],
			["late", "a1", "2026-10-10T12:00:00.000Z"],
			["never", "a1", null],
			["other", "a2", "2026-10-10T11:00:00.000Z"],
		] as const) {
			const { json } = await call("POST", "/submit", submission({ assignment_name: assignment, repo_url: `https://github.com/x/${name}`, student_id: Object.keys(ids).length + 1 }));
			await env.DB.prepare("UPDATE submissions SET last_push = ? WHERE id = ?").bind(lastPush, json.id).run();
			ids[name] = json.id;
		}
		return ids;
	}
	const repos = (json: any) => json.submissions.map((s: any) => s.repo_url.split("/").pop());

	it("returns an assignment's submissions pushed after a time, oldest push first", async () => {
		await seed();
		const { status, json } = await call(
			"POST", "/submissions", { assignment_name: "a1", pushed_after: "2026-10-10T09:00:00Z", order_by: "last_push" }, "authorized",
		);
		expect(status).toBe(200);
		expect(repos(json)).toEqual(["early", "late"]);
	});

	it("is strictly after, and compares correctly whatever the input format", async () => {
		await seed();
		for (const pushed_after of [
			"2026-10-10T10:00:00Z",            // no milliseconds: must not compare as text against "…00.000Z"
			"2026-10-10T10:00:00.000Z",
			"2026-10-10T12:00:00+02:00",       // same instant, other offset
			"2026-10-10T12:00+0200",
			1791626400,                        // unix seconds, number
			"1791626400",                      // unix seconds, string
		]) {
			const { json } = await call("POST", "/submissions", { assignment_name: "a1", pushed_after }, "authorized");
			expect(repos(json), String(pushed_after)).toEqual(["late"]);
		}
	});

	it("works with GET query parameters, including an unencoded + in the offset", async () => {
		await seed();
		const encoded = await call("GET", `/submissions?assignment_name=a1&pushed_after=${encodeURIComponent("2026-10-10T12:00:00+02:00")}`, undefined, "authorized");
		expect(repos(encoded.json)).toEqual(["late"]);
		const raw = await call("GET", "/submissions?assignment_name=a1&pushed_after=2026-10-10T12:00:00+02:00&order_by=last_push", undefined, "authorized");
		expect(raw.status).toBe(200);
		expect(repos(raw.json)).toEqual(["late"]);
	});

	it("filters across all assignments when no assignment_name is given", async () => {
		await seed();
		const { json } = await call("POST", "/submissions", { pushed_after: "2026-10-10T10:30:00Z", order_by: "last_push" }, "authorized");
		expect(repos(json)).toEqual(["other", "late"]);
	});

	it("sorts by last push without a filter, never-pushed submissions last", async () => {
		await seed();
		const { json } = await call("POST", "/submissions", { assignment_name: "a1", order_by: "last_push" }, "authorized");
		expect(repos(json)).toEqual(["early", "late", "never"]);
	});

	it.each([
		["a time without a timezone", { pushed_after: "2026-10-10T10:00:00" }],
		["a date only", { pushed_after: "2026-10-10" }],
		["garbage", { pushed_after: "yesterday" }],
		["a boolean", { pushed_after: true }],
		["an unknown order_by", { order_by: "email" }],
	])("rejects %s", async (_, body) => {
		const { status, json } = await call("POST", "/submissions", body, "authorized");
		expect(status).toBe(400);
		expect(json.error).toBeTypeOf("string");
	});
});

describe("deleting", () => {
	it("DELETE /submissions removes one submission by id", async () => {
		const { json: created } = await call("POST", "/submit", submission());
		const { status, json } = await call("DELETE", "/submissions", { id: created.id }, "authorized");
		expect(status).toBe(200);
		expect(json.deleted).toBe(1);
		expect((await call("DELETE", "/submissions", { id: created.id }, "authorized")).status).toBe(404);

		// The repository can be submitted again once its submission is gone.
		expect((await call("POST", "/submit", submission())).status).toBe(201);
	});

	it("DELETE /submissions validates the id", async () => {
		expect((await call("DELETE", "/submissions", { id: "123" }, "authorized")).status).toBe(400);
		expect((await call("DELETE", "/submissions", {}, "authorized")).status).toBe(400);
	});

	it("DELETE /assignment removes every submission of that assignment only", async () => {
		await call("POST", "/submit", submission({ assignment_name: "a1", repo_url: "https://github.com/x/one", student_id: 1 }));
		await call("POST", "/submit", submission({ assignment_name: "a1", repo_url: "https://github.com/x/two", student_id: 2 }));
		await call("POST", "/submit", submission({ assignment_name: "a2", repo_url: "https://github.com/x/three", student_id: 3 }));

		const { status, json } = await call("DELETE", "/assignment", { assignment_name: "a1" }, "authorized");
		expect(status).toBe(200);
		expect(json.deleted).toBe(2);
		const rest = await call("GET", "/submissions", undefined, "authorized");
		expect(rest.json.submissions.map((s: any) => s.assignment_name)).toEqual(["a2"]);
	});

	it("DELETE /assignment requires assignment_name", async () => {
		expect((await call("DELETE", "/assignment", {}, "authorized")).status).toBe(400);
	});
});

describe("routing", () => {
	it("returns 404 for unknown paths and 405 for wrong methods", async () => {
		expect((await call("GET", "/nope")).status).toBe(404);
		const res = await fetchWorker(new Request(BASE + "/submit"));
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});
});

describe("toSshUrl", () => {
	it.each([
		["https://github.com/Owner/Repo", "git@github.com:owner/repo.git"],
		["https://github.com/owner/repo/tree/main/src", "git@github.com:owner/repo.git"],
		["ssh://git@github.com/owner/repo.git", "git@github.com:owner/repo.git"],
		["git@gitlab.com:group/sub/repo.git", "git@gitlab.com:group/sub/repo.git"],
		["  https://gitlab.com/group/repo/  ", "git@gitlab.com:group/repo.git"],
	])("%s -> %s", (input, expected) => {
		expect(toSshUrl(input)).toBe(expected);
	});

	it.each(["", "github.com/owner/repo", "https://github.com/", "https://github.com/owner", "javascript:alert(1)"])(
		"rejects %j",
		(input) => {
			expect(toSshUrl(input)).toBeNull();
		},
	);
});
