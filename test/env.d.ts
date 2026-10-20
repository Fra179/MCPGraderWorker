declare namespace Cloudflare {
	interface Env {
		ADMIN_PUBLIC_KEYS: string;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
		/** base64 PKCS#8 of the admin key whose public half is in ADMIN_PUBLIC_KEYS. */
		TEST_ADMIN_PRIVATE_KEY: string;
	}
}
