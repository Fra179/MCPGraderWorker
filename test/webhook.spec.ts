import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, call, deliver, fetchWorker, hmacHex, pushPayload, repository, resetDb, SHA_A, SHA_B, submitRepo } from "./helpers";

beforeEach(resetDb);

function row(id: string) {
	return env.DB.prepare("SELECT webhook_seen_at, last_push, last_commit, webhook_secret FROM submissions WHERE id = ?")
		.bind(id)
		.first<any>();
}

describe("POST /webhook/github", () => {
	it("records a ping as proof that the webhook is set up, without a push", async () => {
		const { id, secret } = await submitRepo();
		const { status, json } = await deliver("ping", { zen: "Keep it simple.", repository: repository() }, secret);
		expect(status).toBe(200);
		expect(json.message).toBe("Webhook is set up correctly");
		const r = await row(id);
		expect(r.webhook_seen_at).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(r.last_push).toBeNull();
	});

	it("records a push to the default branch: arrival time and head commit", async () => {
		const { id, secret } = await submitRepo();
		const before = new Date().toISOString();
		const { status, json } = await deliver("push", pushPayload(), secret);
		expect(status).toBe(200);
		expect(json).toMatchObject({ recorded: true, last_commit: SHA_A });

		const r = await row(id);
		expect(r.last_push).toBe(json.last_push);
		expect(r.last_push >= before && r.last_push <= new Date().toISOString()).toBe(true);
		expect(r.last_commit).toBe(SHA_A);
	});

	it("ignores the payload's pushed_at, so a student can't backdate a push with their own secret", async () => {
		const { id, secret } = await submitRepo();
		const before = new Date().toISOString();
		await deliver("push", pushPayload({}, repository(undefined, 946684800 /* 2000-01-01 */)), secret);
		expect((await row(id)).last_push >= before).toBe(true);
	});

	it("records the latest delivered push", async () => {
		const { id, secret } = await submitRepo();
		await deliver("push", pushPayload({ after: SHA_A }), secret);
		await deliver("push", pushPayload({ after: SHA_B }), secret);
		expect((await row(id)).last_commit).toBe(SHA_B);
	});

	it("exposes the push fields to admins", async () => {
		const { secret } = await submitRepo();
		await deliver("push", pushPayload(), secret);
		const { json } = await call("GET", "/submissions", undefined, "authorized");
		expect(json.submissions[0]).toMatchObject({ last_commit: SHA_A });
		expect(json.submissions[0].webhook_secret).toBeUndefined();
	});

	it("matches the repository however GitHub spells it (case, www, .git)", async () => {
		const { id, secret } = await submitRepo("https://www.github.com/Student/VectorSum.git");
		const { status } = await deliver("push", pushPayload({}, repository("Student/VectorSum")), secret);
		expect(status).toBe(200);
		expect((await row(id)).last_commit).toBe(SHA_A);
	});

	it.each([
		["another branch", { ref: "refs/heads/feature" }, "Not a push to the default branch (main)"],
		["a tag", { ref: "refs/tags/v1" }, "Not a push to the default branch (main)"],
		["a branch deletion", { deleted: true, after: "0".repeat(40) }, "Branch deletion"],
	])("ignores %s but still marks the webhook as seen", async (_, overrides, message) => {
		const { id, secret } = await submitRepo();
		const { status, json } = await deliver("push", pushPayload(overrides), secret);
		expect(status).toBe(200);
		expect(json).toMatchObject({ recorded: false, message });
		const r = await row(id);
		expect(r.last_push).toBeNull();
		expect(r.webhook_seen_at).not.toBeNull();
	});

	it("rejects a delivery signed with the wrong secret", async () => {
		const { id } = await submitRepo();
		const { status, json } = await deliver("push", pushPayload(), "f".repeat(64));
		expect(status).toBe(401);
		expect(json.error).toMatch(/doesn't match/);
		expect((await row(id)).webhook_seen_at).toBeNull();
	});

	it("rejects another submission's secret: one student can't update another's repository", async () => {
		await submitRepo("https://github.com/alice/repo");
		const bob = await submitRepo("https://github.com/bob/repo", 7654321);
		const { status } = await deliver("push", pushPayload({}, repository("alice/repo")), bob.secret);
		expect(status).toBe(401);
	});

	it("rejects a body changed after signing", async () => {
		const { secret } = await submitRepo();
		const signed = `sha256=${await hmacHex(secret, JSON.stringify(pushPayload()))}`;
		const { status } = await deliver("push", pushPayload({ after: SHA_B }), secret, signed);
		expect(status).toBe(401);
	});

	it.each([
		["no signature", null],
		["a malformed signature", "sha256=xyz"],
		["a sha1 signature", `sha1=${"0".repeat(40)}`],
	])("rejects %s", async (_, signature) => {
		const { secret } = await submitRepo();
		expect((await deliver("push", pushPayload(), secret, signature)).status).toBe(401);
	});

	it("tells the student to fix the content type when GitHub sends form-encoded payloads", async () => {
		const { secret } = await submitRepo();
		const { status, json } = await deliver("push", "payload=%7B%7D", secret);
		expect(status).toBe(415);
		expect(json.error).toMatch(/application\/json/);
	});

	it("answers 404 for a repository that was never submitted", async () => {
		const { secret } = await submitRepo();
		const { status, json } = await deliver("push", pushPayload({}, repository("someone/else")), secret);
		expect(status).toBe(404);
		expect(json.error).toContain("someone/else");
	});

	it("answers 400 for requests that aren't GitHub deliveries", async () => {
		const res = await fetchWorker(new Request(`${BASE}/webhook/github`, { method: "POST", body: "{}" }));
		expect(res.status).toBe(400);
	});
});

describe("POST /webhook-secret", () => {
	it("replaces the secret: the old one stops working, the new one works", async () => {
		const { id, secret: oldSecret } = await submitRepo();
		const { status, json } = await call("POST", "/webhook-secret", { id }, "authorized");
		expect(status).toBe(200);
		expect(json.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
		expect(json.webhook_secret).not.toBe(oldSecret);
		expect(json.webhook_url).toBe(`${BASE}/webhook/github`);

		expect((await deliver("ping", { repository: repository() }, oldSecret)).status).toBe(401);
		expect((await deliver("ping", { repository: repository() }, json.webhook_secret)).status).toBe(200);
	});

	it("answers 404 for an unknown submission and 400 for a bad id", async () => {
		expect((await call("POST", "/webhook-secret", { id: crypto.randomUUID() }, "authorized")).status).toBe(404);
		expect((await call("POST", "/webhook-secret", { id: "nope" }, "authorized")).status).toBe(400);
	});
});
