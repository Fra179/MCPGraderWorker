// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them; declare them here.
interface Env {
	/** JSON object {"<name>": "<base64 SPKI DER>"} of the public keys allowed to sign admin requests. */
	ADMIN_PUBLIC_KEYS: string; // undefined at runtime if the secret was never set
}
