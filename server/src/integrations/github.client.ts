/** Thin GitHub REST client using a user OAuth token (Node global fetch). */
export class GithubClient {
  constructor(private readonly token: string) {}

  private async get(path: string) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rootvector',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} on ${path}`);
    }
    return res.json();
  }

  async viewer() {
    return this.get('/user');
  }

  async repositories() {
    const repos: any[] = await this.get(
      '/user/repos?sort=updated&per_page=30&affiliation=owner,collaborator,organization_member',
    );
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      url: r.html_url,
      description: r.description,
      language: r.language,
      defaultBranch: r.default_branch,
      openIssues: r.open_issues_count,
      stars: r.stargazers_count,
      pushedAt: r.pushed_at,
    }));
  }

  /** Recent activity the user performed, mapped to RootVector activity items. */
  async recentActivity(login: string) {
    const events: any[] = await this.get(`/users/${login}/events?per_page=30`);
    const out: any[] = [];
    for (const ev of events) {
      const repo = ev.repo?.name ? ev.repo.name.split('/').pop() : undefined;
      const url = ev.repo?.name ? `https://github.com/${ev.repo.name}` : undefined;
      if (ev.type === 'PushEvent') {
        const n = ev.payload?.size ?? ev.payload?.commits?.length ?? 0;
        const ref = (ev.payload?.ref || '').replace('refs/heads/', '');
        const title = n > 0
          ? `${n} commit${n === 1 ? '' : 's'} pushed${ref ? ' to ' + ref : ''}`
          : `Pushed to ${ref || repo}`;
        out.push({ kind: 'push', title, service: repo, url, at: ev.created_at });
      } else if (ev.type === 'PullRequestEvent') {
        const pr = ev.payload?.pull_request;
        const merged = ev.payload?.action === 'closed' && pr?.merged;
        out.push({ kind: merged ? 'pr_merged' : 'push', title: `PR #${pr?.number} ${merged ? 'merged' : ev.payload?.action}`, service: repo, url: pr?.html_url, at: ev.created_at });
      } else if (ev.type === 'ReleaseEvent') {
        out.push({ kind: 'deployment', title: `Release ${ev.payload?.release?.tag_name || ''}`.trim(), service: repo, url, at: ev.created_at });
      } else if (ev.type === 'CreateEvent' && ev.payload?.ref_type === 'tag') {
        out.push({ kind: 'deployment', title: `Tag ${ev.payload.ref}`, service: repo, url, at: ev.created_at });
      } else if (ev.type === 'IssuesEvent' && ev.payload?.action === 'opened') {
        out.push({ kind: 'error', title: `Issue: ${(ev.payload?.issue?.title || '').slice(0, 48)}`, service: repo, url: ev.payload?.issue?.html_url, at: ev.created_at });
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  async pulls(fullName: string, state = 'all') {
    const prs: any[] = await this.get(
      `/repos/${fullName}/pulls?state=${state}&per_page=10&sort=updated&direction=desc`,
    );
    return prs.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.merged_at ? 'merged' : p.state,
      author: p.user?.login,
      url: p.html_url,
      updatedAt: p.updated_at,
    }));
  }
}
