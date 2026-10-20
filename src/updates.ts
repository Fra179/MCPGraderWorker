import { jsonResponse } from "./http";
import { ADMIN_COLUMNS } from "./submissions";

/** Run after incrementing push_version in the same batch as the push itself. */
export function recordUpdate(env: Env, repoSshUrl: string): D1PreparedStatement {
	return env.DB.prepare(`INSERT INTO updates (repo_ssh_url, update_id)
		SELECT repo_ssh_url, push_version FROM submissions WHERE repo_ssh_url = ?
		ON CONFLICT (repo_ssh_url) DO UPDATE SET update_id = excluded.update_id`).bind(repoSshUrl);
}

/** Reading does not acknowledge any work. */
export async function getUpdates(_request: Request, env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS},
		(SELECT update_id FROM updates WHERE updates.repo_ssh_url = submissions.repo_ssh_url) AS update_id
		FROM submissions WHERE repo_ssh_url IN (SELECT repo_ssh_url FROM updates)
		ORDER BY last_push NULLS LAST, created_at`).all();
	return jsonResponse({ submissions: results });
}

