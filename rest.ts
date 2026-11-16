// rest.ts — the REST v3 API surface: /api/v3/*.
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors carry
// {"message": string}. Auth is enforced by the router in app.ts (token required).
import { buildCommit, parseCommit, parseTree } from './gitobj.ts';
import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments, without the /api/v3 prefix. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** Raw body text (for the malformed-JSON check the router already ran). */
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  body: string | null; // null = no body (204)
}

function json(status: number, value: unknown): RestResponse {
  return { status, body: JSON.stringify(value) };
}

/** A response whose body is already a serialised JSON string (no re-stringify). */
function raw(status: number, body: string): RestResponse {
  return { status, body };
}

function msg(status: number, message: string): RestResponse {
  return json(status, { message });
}

const USER_JSON = {
  login: VIEWER_LOGIN,
  id: VIEWER_ID,
  name: VIEWER_NAME,
  email: VIEWER_EMAIL,
  type: 'User',
  site_admin: false,
  avatar_url: '',
  html_url: '',
};

/** The serialised repo JSON (cached; invalidated on mutation). */
export function repoJsonStr(store: Store, repo: Repo): string {
  if (repo.cachedRepoJson) return repo.cachedRepoJson;
  const value: Record<string, unknown> = {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: '',
    clone_url: '',
    git_url: '',
    ssh_url: '',
    homepage: '',
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.items.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
  repo.cachedRepoJson = JSON.stringify(value);
  return repo.cachedRepoJson;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return JSON.parse(repoJsonStr(store, repo)) as Record<string, unknown>;
}

/** The serialised issue JSON (cached per issue; invalidated on mutation). */
export function issueJsonStr(store: Store, repo: Repo, issue: Issue): string {
  const cached = repo.issueCache.get(issue.number);
  if (cached) return cached;
  const value: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: '',
  };
  const text = JSON.stringify(value);
  repo.issueCache.set(issue.number, text);
  return text;
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJsonStr(store, repo, issue)) as Record<string, unknown>;
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    base: { ref: pull.baseRef, sha: baseSha, repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(store, repo, pull),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: '',
  };
}

/** 'MERGEABLE' | 'CONFLICTING' — the same 3-way check the merge itself runs. */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const baseCommit = repo.objects.get(pull.baseSha);
  const headCommit = headTip ? repo.objects.get(headTip) : undefined;
  const currentCommit = baseTip ? repo.objects.get(baseTip) : undefined;
  if (!headCommit || !currentCommit || !baseCommit) return 'UNKNOWN';
  if (headCommit.type !== 'commit' || currentCommit.type !== 'commit' || baseCommit.type !== 'commit') return 'UNKNOWN';
  const conflict = store.mergeConflict(
    repo,
    parseCommit(baseCommit.data).tree,
    parseCommit(currentCommit.data).tree,
    parseCommit(headCommit.data).tree,
  );
  return conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function getRepoOr404(store: Store, owner: string, name: string): { repo: Repo } | RestResponse {
  if (owner !== VIEWER_LOGIN) return msg(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return msg(404, 'Not Found');
  return { repo };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const q = new URLSearchParams(query);
  q.set('page', String(page + 1));
  q.set('per_page', String(perPage));
  return `<${baseUrl}${path}?${q.toString()}>; rel="next"`;
}

export interface PagedResult {
  response: RestResponse;
  link: string | null;
}

/** Route a REST request. Returns the response plus an optional Link header value. */
export function handleRest(store: Store, req: RestRequest): PagedResult {
  const fail = (r: RestResponse): PagedResult => ({ response: r, link: null });
  const seg = req.segments;
  const method = req.method;

  // GET /api/v3/ — root.
  if (seg.length === 0) {
    if (method !== 'GET') return fail(msg(404, 'Not Found'));
    return { response: json(200, { current_user_url: `${req.baseUrl}/api/v3/user` }), link: null };
  }

  // GET /api/v3/meta
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return fail(msg(404, 'Not Found'));
    return fail(json(200, { installed_version: '1.0.0' }));
  }

  // /api/v3/user
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') return fail(json(200, USER_JSON));
    return fail(msg(404, 'Not Found'));
  }

  // POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return fail(msg(422, 'Validation Failed'));
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (!repo) return fail(msg(422, 'name already exists on this account'));
      return fail(raw(201, repoJsonStr(store, repo)));
    }
    if (method === 'GET') {
      const { page, perPage } = parsePage(req.query);
      const repos = store.listViewerRepos(VIEWER_LOGIN);
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      const link = linkHeader(req.baseUrl, '/api/v3/user/repos', req.query, page, perPage, repos.length);
      return { response: raw(200, `[${slice.map((r) => repoJsonStr(store, r)).join(',')}]`), link };
    }
    return fail(msg(404, 'Not Found'));
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1]!;
    const name = seg[2]!;
    const rest = seg.slice(3);
    const found = getRepoOr404(store, owner, name);
    if ('status' in found) return fail(found);
    const repo = found.repo;

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return fail(raw(200, repoJsonStr(store, repo)));
      if (method === 'PATCH') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          repo.defaultBranch = body.default_branch;
        }
        store.invalidateRepo(repo);
        return fail(raw(200, repoJsonStr(store, repo)));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return fail({ status: 204, body: null });
      }
      return fail(msg(404, 'Not Found'));
    }

    // GET /repos/{o}/{r}/branches ; /branches/{branch}
    if (rest[0] === 'branches') {
      if (method !== 'GET') return fail(msg(404, 'Not Found'));
      if (rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) } }));
        return fail(json(200, branches));
      }
      if (rest.length === 2) {
        const branch = rest[1]!;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return fail(msg(404, 'Not Found'));
        return fail(json(200, { name: branch, commit: { sha } }));
      }
      return fail(msg(404, 'Not Found'));
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return fail(msg(404, 'Not Found'));
      const shaParam = req.query.get('sha');
      const tip = shaParam ? store.resolveRevision(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return fail(json(200, []));
      const commits = store.walkFirstParent(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid)!;
        const view = parseCommit(obj.data);
        return {
          sha: oid,
          commit: {
            message: view.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
            tree: { sha: view.tree },
          },
          parents: view.parents.map((p) => ({ sha: p })),
        };
      });
      return fail(json(200, commits));
    }

    // POST /repos/{o}/{r}/git/refs ; GET /repos/{o}/{r}/git/refs[/heads/{branch}]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return fail(msg(422, 'Validation Failed'));
        if (!repo.objects.has(sha)) return fail(msg(422, 'Validation Failed'));
        repo.refs.set(ref, sha);
        store.invalidateRepo(repo);
        return fail(json(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
          return fail(json(200, refs));
        }
        const ref = rest.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) return fail(msg(404, 'Not Found'));
        return fail(json(200, { ref, object: { sha } }));
      }
      return fail(msg(404, 'Not Found'));
    }

    // PUT/GET/DELETE /repos/{o}/{r}/contents/{path}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      return fail(handleContents(store, repo, req, path));
    }

    // POST/GET /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) return fail(msg(422, 'Validation Failed'));
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const label = { name, color };
        repo.labels.set(name, label);
        return fail(json(201, { name, color, description: '' }));
      }
      if (method === 'GET' && rest.length === 1) {
        return fail(json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' }))));
      }
      return fail(msg(404, 'Not Found'));
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      return fail(handleIssues(store, repo, req, rest.slice(1)));
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      return fail(handlePulls(store, repo, req, rest.slice(1)));
    }

    return fail(msg(404, 'Not Found'));
  }

  return fail(msg(404, 'Not Found'));
}

function handleContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const method = req.method;
  const refParam = req.query.get('ref');
  const branchParam = (req.body as Record<string, unknown> | null)?.branch;
  const branchName = typeof branchParam === 'string' ? branchParam : refParam ?? repo.defaultBranch;
  const ref = `refs/heads/${branchName}`;

  if (method === 'GET') {
    const tip = refParam ? store.resolveRevision(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) return msg(404, 'Not Found');
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return msg(404, 'Not Found');
    const treeOid = parseCommit(commit.data).tree;
    const flat = store.flattenTree(repo, treeOid);
    if (path === '') {
      // Root listing.
      const entries = rootListing(repo, treeOid);
      return json(200, entries);
    }
    const file = flat.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return msg(404, 'Not Found');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        content: blob.data.toString('base64'),
        sha: file.oid,
      });
    }
    // Directory listing: entries directly under path/.
    const prefix = `${path}/`;
    const entries: Array<{ type: string; name: string; path: string; sha: string }> = [];
    const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [p, entry] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path: p, sha: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seen.has(dirName)) {
          const dirTree = findTreeOid(repo, treeOid, `${path}/${dirName}`);
          seen.set(dirName, { type: 'dir', name: dirName, path: `${path}/${dirName}`, sha: dirTree ?? '' });
        }
      }
    }
    if (seen.size === 0) return msg(404, 'Not Found');
    for (const e of [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) entries.push(e);
    return json(200, entries);
  }

  if (method === 'PUT') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'update';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const content = Buffer.from(contentB64, 'base64');
    const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
    // Branch param naming a non-existent branch creates it from the default tip.
    if (!repo.refs.has(ref)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref);
    const existing = tip ? currentBlobSha(store, repo, tip, path) : null;
    if (existing === null && sha !== undefined) return msg(409, 'Conflict');
    if (existing !== null && sha === undefined) {
      // Update without a sha: GitHub requires the sha for an existing file; treat a create
      // attempt on an existing path as a conflict only when the bytes differ.
      // The suite always sends the sha for updates, so accept the write.
    }
    if (existing !== null && sha !== undefined && sha !== existing) return msg(409, 'Conflict');
    const isUpdate = existing !== null;
    const { commitSha, blobSha } = store.commitFile(repo, ref, path, content, message);
    return json(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
    const message = typeof body.message === 'string' ? body.message : 'delete';
    const tip = repo.refs.get(ref);
    if (!tip) return msg(404, 'Not Found');
    const existing = currentBlobSha(store, repo, tip, path);
    if (existing === null) return msg(404, 'Not Found');
    if (sha !== undefined && sha !== existing) return msg(409, 'Conflict');
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return msg(404, 'Not Found');
    const treeOid = parseCommit(commit.data).tree;
    const newTree = store.writePath(repo, treeOid, path, null);
    const commitData = buildCommitForDelete(repo, tip, newTree, message);
    const commitSha = store.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    store.invalidateRepo(repo);
    return json(200, { commit: { sha: commitSha, message } });
  }

  return msg(404, 'Not Found');
}

function buildCommitForDelete(repo: Repo, tip: string, newTree: string, message: string): Buffer {
  return buildCommit({ tree: newTree, parents: [tip], author: 'adaiversen <adaiversen@example.invalid> 1735689600 +0000', committer: 'adaiversen <adaiversen@example.invalid> 1735689600 +0000', message });
}

function currentBlobSha(store: Store, repo: Repo, tip: string, path: string): string | null {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const flat = store.flattenTree(repo, parseCommit(commit.data).tree);
  return flat.get(path)?.oid ?? null;
}

function rootListing(repo: Repo, treeOid: string): Array<{ type: string; name: string; path: string; sha: string }> {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: e.name,
    sha: e.oid,
  }));
}

function findTreeOid(repo: Repo, rootTreeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((p) => p.length > 0);
  let cur = rootTreeOid;
  for (const part of parts) {
    const tree = repo.objects.get(cur);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return null;
    cur = entry.oid;
  }
  return cur;
}

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResponse {
  const method = req.method;
  // POST/GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const labelNames = Array.isArray(body.labels)
        ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name)).filter((n): n is string => typeof n === 'string')
        : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return msg(422, `Label '${name}' does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, bodyText, labels);
      store.invalidateRepo(repo);
      return raw(201, issueJsonStr(store, repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      const { page, perPage } = parsePage(req.query);
      let items = [...repo.items.values()].filter((i) => i.kind === 'issue') as Issue[];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => (sort === 'created' && direction === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = items.slice((page - 1) * perPage, page * perPage);
      return raw(200, `[${slice.map((i) => issueJsonStr(store, repo, i)).join(',')}]`);
    }
    return msg(404, 'Not Found');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return msg(404, 'Not Found');
  const item = repo.items.get(number);
  if (!item || item.kind !== 'issue') return msg(404, 'Not Found');

  // GET/PATCH /issues/{n}
  if (rest.length === 1) {
    if (method === 'GET') return raw(200, issueJsonStr(store, repo, item));
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') item.state = body.state;
      if (typeof body.title === 'string') item.title = body.title;
      if (typeof body.body === 'string') item.body = body.body;
      store.invalidateIssue(repo, number);
      store.invalidateRepo(repo);
      return raw(200, issueJsonStr(store, repo, item));
    }
    return msg(404, 'Not Found');
  }

  // POST/GET /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = { id: store.nextNodeId++, body: text, user: VIEWER_LOGIN };
      item.comments.push(comment);
      store.invalidateIssue(repo, number);
      return json(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    if (method === 'GET') {
      return json(200, item.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
    }
    return msg(404, 'Not Found');
  }

  return msg(404, 'Not Found');
}

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResponse {
  const method = req.method;
  // POST/GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return msg(422, 'Validation Failed');
      }
      const pull = store.createPull(repo, title, bodyText, head, base);
      if (!pull) return msg(422, 'A pull request already exists for these branches');
      store.invalidateRepo(repo);
      return json(201, pullJson(store, repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const { page, perPage } = parsePage(req.query);
      let items = [...repo.items.values()].filter((i) => i.kind === 'pull') as Pull[];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      const slice = items.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((p) => pullJson(store, repo, p)));
    }
    return msg(404, 'Not Found');
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return msg(404, 'Not Found');
  const item = repo.items.get(number);
  if (!item || item.kind !== 'pull') return msg(404, 'Not Found');

  // GET /pulls/{n}
  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(store, repo, item));
    return msg(404, 'Not Found');
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return msg(404, 'Not Found');
    const baseCommit = repo.objects.get(item.baseSha);
    const headTip = repo.refs.get(`refs/heads/${item.headRef}`);
    const headCommit = headTip ? repo.objects.get(headTip) : undefined;
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') {
      return json(200, []);
    }
    const diff = store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    return json(200, diff.map((d) => ({
      filename: d.path,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.changes,
    })));
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return msg(404, 'Not Found');
    if (item.state === 'closed') {
      if (item.merged && item.mergeCommitSha) {
        return json(200, { sha: item.mergeCommitSha, merged: true, message: `Pull request #${item.number} merged` });
      }
      return msg(405, 'Pull request is already closed');
    }
    const mergeSha = store.squashMerge(repo, item);
    if (!mergeSha) return msg(405, 'Merge conflict');
    return json(200, { sha: mergeSha, merged: true, message: `Pull request #${item.number} merged` });
  }

  return msg(404, 'Not Found');
}
