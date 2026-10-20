import { webcrypto } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_ORIGIN = "https://site.test";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	// A fresh admin key pair per run: the worker gets the public half, the tests sign with the private half.
	const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const b64 = async (format: "spki" | "pkcs8", key: webcrypto.CryptoKey) =>
		Buffer.from(await webcrypto.subtle.exportKey(format, key)).toString("base64");

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						TEST_ADMIN_PRIVATE_KEY: await b64("pkcs8", pair.privateKey),
						ADMIN_PUBLIC_KEYS: JSON.stringify({ "test-admin": await b64("spki", pair.publicKey) }),
						ALLOWED_ORIGINS: `${TEST_ORIGIN}, http://localhost:1313`,
					},
				},
			}),
		],
		test: { setupFiles: ["./test/apply-migrations.ts"] },
	};
});
