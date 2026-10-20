#!/usr/bin/env bash
# Manage the ECDSA P-256 key pairs allowed to sign admin requests. Files live in keys/ (gitignored).
#
# The private key (keys/<name>.key) is uploaded once into the admin page and stays in that browser.
# The worker only knows the public keys, through the secret ADMIN_PUBLIC_KEYS.
#
#   scripts/admin-keys.sh new <name>      generate keys/<name>.key + keys/<name>.pub
#   scripts/admin-keys.sh list            show the authorized keys
#   scripts/admin-keys.sh revoke <name>   delete a key pair (run `push` afterwards)
#   scripts/admin-keys.sh push            upload the public keys as the Worker secret ADMIN_PUBLIC_KEYS
#   scripts/admin-keys.sh dev-vars        write ADMIN_PUBLIC_KEYS into .dev.vars for `npm run dev`
set -euo pipefail

cd "$(dirname "$0")/.."
KEYS_DIR=keys
SECRET_NAME=ADMIN_PUBLIC_KEYS

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# {"name": "<base64 SPKI>", ...} built from keys/*.pub. Names are restricted to [A-Za-z0-9._-], so no escaping is needed.
public_keys_json() {
	local first=1 pub
	printf '{'
	for pub in "$KEYS_DIR"/*.pub; do
		[[ -e "$pub" ]] || continue
		[[ $first -eq 1 ]] || printf ','
		printf '"%s":"%s"' "$(basename "$pub" .pub)" "$(cat "$pub")"
		first=0
	done
	printf '}'
}

cmd_new() {
	local name="${1:-}"
	[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Key name must match [A-Za-z0-9._-]+" >&2; exit 1; }
	[[ -e "$KEYS_DIR/$name.key" ]] && { echo "$KEYS_DIR/$name.key already exists; revoke it first." >&2; exit 1; }

	mkdir -p "$KEYS_DIR"
	# PKCS#8 PEM, which WebCrypto can import in the browser.
	(umask 077 && openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEYS_DIR/$name.key")
	openssl pkey -in "$KEYS_DIR/$name.key" -pubout -outform DER | base64 -w0 > "$KEYS_DIR/$name.pub"

	cat <<EOF
Created $KEYS_DIR/$name.key (private, upload it in the admin page) and $KEYS_DIR/$name.pub.
Next: '$0 push' to authorize it on the deployed worker, or '$0 dev-vars' for local dev.
EOF
}

cmd_list() {
	local pub found=0
	for pub in "$KEYS_DIR"/*.pub; do
		[[ -e "$pub" ]] || continue
		printf '%-24s %s\n' "$(basename "$pub" .pub)" "$(cut -c1-48 "$pub")…"
		found=1
	done
	[[ $found -eq 1 ]] || echo "No keys."
}

cmd_revoke() {
	local name="${1:-}"
	[[ -n "$name" && -e "$KEYS_DIR/$name.pub" ]] || { echo "No key named '$name'." >&2; exit 1; }
	rm -f "$KEYS_DIR/$name.key" "$KEYS_DIR/$name.pub"
	echo "Deleted '$name'. Run '$0 push' to revoke it on the deployed worker."
}

cmd_push() {
	# An empty object is valid: it revokes every key.
	public_keys_json | npx wrangler secret put "$SECRET_NAME"
}

cmd_dev_vars() {
	touch .dev.vars
	grep -v "^$SECRET_NAME=" .dev.vars > .dev.vars.tmp || true
	echo "$SECRET_NAME=$(public_keys_json)" >> .dev.vars.tmp
	mv .dev.vars.tmp .dev.vars
	echo "Wrote $SECRET_NAME to .dev.vars (restart 'npm run dev' to pick it up)."
}

case "${1:-}" in
	new) shift; cmd_new "$@" ;;
	list) cmd_list ;;
	revoke) shift; cmd_revoke "$@" ;;
	push) cmd_push ;;
	dev-vars) cmd_dev_vars ;;
	*) usage ;;
esac
