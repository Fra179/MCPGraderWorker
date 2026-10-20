/**
 * Normalize a submitted repository URL to `git@host:owner/repo.git`, or return null if it isn't one.
 * Mirrors `to_ssh_url` in the grader (google_form/repo_url.py) so both sides agree on what a repo is.
 * Accepts https://, http://, ssh:// URLs and the scp-like `git@host:owner/repo(.git)` form.
 */
export function toSshUrl(repoUrl: string): string | null {
	const url = repoUrl.trim();
	if (/\s/.test(url)) return null;

	let host: string;
	let path: string;

	const scp = /^git@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(url);
	if (scp) {
		host = scp[1].toLowerCase();
		path = scp[2];
	} else {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (!["http:", "https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname) return null;
		host = parsed.hostname.replace(/^www\./, "");
		path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	}

	let parts = path.split("/");
	if (parts.length < 2 || parts.some((p) => p === "")) return null;

	if (host === "github.com") {
		// GitHub paths are case-insensitive: lowercase so Owner/Repo and owner/repo collide on uniqueness.
		parts = parts.slice(0, 2).map((p) => p.toLowerCase());
	}

	return `git@${host}:${parts.join("/")}.git`;
}
