export interface DeployKey {
	/** OpenSSH public key line, pasted by the student into GitHub -> Settings -> Deploy keys. */
	publicKey: string;
	/** PKCS#8 PEM private key, accepted by `ssh -i`. */
	privateKey: string;
}

/** Generate an ECDSA P-256 key pair usable as an SSH deploy key. */
export async function generateDeployKey(comment: string): Promise<DeployKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;

	const point = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);

	// RFC 5656 section 3.1: string "ecdsa-sha2-nistp256", string "nistp256", string Q (uncompressed point)
	const blob = concat(sshString(encode("ecdsa-sha2-nistp256")), sshString(encode("nistp256")), sshString(point));

	return {
		publicKey: `ecdsa-sha2-nistp256 ${toBase64(blob)} ${comment}`,
		privateKey: pem("PRIVATE KEY", pkcs8),
	};
}

function encode(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function sshString(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + data.length);
	new DataView(out.buffer).setUint32(0, data.length);
	out.set(data, 4);
	return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function toBase64(data: Uint8Array): string {
	return btoa(String.fromCharCode(...data));
}

function pem(label: string, der: Uint8Array): string {
	const lines = toBase64(der).match(/.{1,64}/g)!.join("\n");
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
