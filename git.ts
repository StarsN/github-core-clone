// git.ts — git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack,
// and v0 receive-pack. All framing follows the wire contract the suite's client speaks.
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  parsePktLines,
  parsePktLinesPrefix,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
  type Pkt,
} from './gitobj.ts';
import { Store, VIEWER_LOGIN, type Repo } from './store.ts';

export const AGENT = 'github-core-clone/1.0.0';

const V2_CAPS = ['agent=' + AGENT, 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const V0_UPLOAD_CAPS = [
  'side-band-64k',
  'multi_ack_detailed',
  'thin-pack',
  'no-progress',
  'ofs-delta',
  'shallow',
  'agent=' + AGENT,
];
const V0_RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'ofs-delta',
  'delete-refs',
  'agent=' + AGENT,
];

export interface GitRequest {
  method: string;
  headers: Map<string, string>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** All refs of a repo, sorted: HEAD first (when it resolves), then refs/heads/*, refs/tags/*. */
export function listRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip) out.push({ oid: mainTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    out.push({ oid, name });
    // Peeled tag line, when the ref is an annotated tag.
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        out.push({ oid: parseTag(obj.data).object, name: `${name}^{}` });
      }
    }
  }
  return out;
}

function headSymrefTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** v0 advertisement body, with the `# service=...` preamble. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, caps: string[]): Buffer {
  const refs = listRefs(repo);
  const capText = caps.join(' ');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capText}\n`));
  } else {
    refs.forEach((ref, i) => {
      const line = i === 0 ? `${ref.oid} ${ref.name}\0${capText}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
    });
    // HEAD symref goes in the caps of the first line.
    if (refs[0]!.name === 'HEAD') {
      parts[2] = pktLine(`${refs[0]!.oid} HEAD\0symref=HEAD:${headSymrefTarget(repo)} ${capText}\n`);
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement body. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, protocol: string): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return err(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (protocol === '2') {
      return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    }
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', repo, V0_UPLOAD_CAPS));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo, V0_RECEIVE_CAPS));
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs / fetch
// -------------------------------------------------------------------------------------------

interface V2Args {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Args | null {
  let packets: Pkt[];
  try {
    packets = parsePktLines(body);
  } catch {
    return null;
  }
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  if (!command) return null;
  return { command, args };
}

function handleLsRefs(repo: Repo, args: string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip === undefined) {
    // Unborn repository.
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:${headSymrefTarget(repo)}\n`));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(`${mainTip} HEAD${symrefs ? ` symref-target:${headSymrefTarget(repo)}` : ''}\n`));
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (peel && name.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function handleFetchV2(store: Store, repo: Repo, args: string[]): GitResponse {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const arg of args) {
    if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) plan.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) plan.depth = parseInt(arg.slice(7).trim(), 10);
  }
  return serveFetch(store, repo, plan, 2);
}

/** Shared v2/v0 fetch response builder. version 2 = sectioned, 0 = flat. */
function serveFetch(store: Store, repo: Repo, plan: FetchPlan, version: 2 | 0): GitResponse {
  const { included, newShallow, unshallow, tags } = store.planFetch(repo, plan.wants, plan.haves, plan.shallow, plan.depth);
  const objects = store.fetchObjects(repo, included, plan.haves, plan.shallow, tags);
  const pack = objects.size ? writePack(objects.values()) : null;
  const acks: string[] = [];
  for (const have of plan.haves) {
    if (repo.objects.has(have.toLowerCase())) acks.push(have.toLowerCase());
  }
  if (version === 2) {
    const parts: Buffer[] = [];
    // The acknowledgments section is only sent when the client sent haves: a real
    // git client that sent no haves expects the response to start with the packfile
    // (or shallow-info) section and dies "expected 'packfile', received
    // 'acknowledgments'" otherwise. The kit client reads sections by header name,
    // so omitting it is safe for both.
    if (plan.haves.length) {
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(DELIM);
    }
    if (newShallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    if (pack) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandWrap(1, pack));
    }
    parts.push(FLUSH);
    return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  // v0: flat pkt-lines — NAK/ACK, shallow lines, then sideband pack, then flush.
  const parts: Buffer[] = [];
  if (acks.length) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack) parts.push(sidebandWrap(1, pack));
  parts.push(FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// v0 upload-pack
// -------------------------------------------------------------------------------------------

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  let packets: Pkt[];
  try {
    packets = parsePktLines(body);
  } catch {
    return err(400, 'malformed pkt-line stream');
  }
  // Two sections: wants (+ shallow/deepen) up to the first flush, then haves + done.
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        // First token after 'want ' is the oid; the rest are capabilities.
        plan.wants.push(line.slice(5).split(' ')[0]!);
      } else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    }
  }
  if (plan.wants.length === 0) return err(400, 'no want lines');
  return serveFetch(store, repo, plan, 0);
}

// -------------------------------------------------------------------------------------------
// v0 receive-pack
// -------------------------------------------------------------------------------------------

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  // Command lines up to the first flush; everything after is the raw pack.
  // The pack bytes are NOT pkt-lines, so parse only the prefix.
  let prefix: { packets: Pkt[]; consumed: number };
  try {
    prefix = parsePktLinesPrefix(body);
  } catch {
    return err(400, 'malformed pkt-line stream');
  }
  const packets = prefix.packets;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let flushAt = -1;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i]!;
    if (p.kind === 'flush') {
      flushAt = i;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
    if (!m) return pushReport([{ ref: '', ok: false, reason: 'malformed command' }], false);
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  if (flushAt < 0 || commands.length === 0) {
    return pushReport([{ ref: '', ok: false, reason: 'malformed command' }], false);
  }
  const packBytes = body.subarray(prefix.consumed);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  if (hasUpdates) {
    if (packBytes.length < 12) {
      unpackOk = false;
    } else {
      try {
        const objects = readPack(packBytes, (oid) => store.getObject(repo, oid));
        store.putObjects(repo, objects.values());
      } catch {
        unpackOk = false;
      }
    }
  }
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const c of commands) report.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
    return pushReport(report, false);
  }
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: c.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current.toLowerCase() !== c.oldOid.toLowerCase() && c.oldOid !== ZERO_OID) {
        report.push({ ref: c.ref, ok: false, reason: 'remote ref updated since checkout' });
      } else {
        repo.refs.delete(c.ref);
        report.push({ ref: c.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.get(c.newOid.toLowerCase());
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      report.push({ ref: c.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (c.oldOid !== ZERO_OID) {
        report.push({ ref: c.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid.toLowerCase());
      report.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    if (current.toLowerCase() !== c.oldOid.toLowerCase()) {
      report.push({ ref: c.ref, ok: false, reason: 'remote ref updated since checkout' });
      continue;
    }
    // Fast-forward check (tags: same rule — a tag move must fast-forward too).
    if (newObj.type === 'commit' && !store.isAncestor(repo, current, c.newOid.toLowerCase())) {
      report.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(c.ref, c.newOid.toLowerCase());
    report.push({ ref: c.ref, ok: true, reason: '' });
  }
  return pushReport(report, true);
}

function pushReport(report: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean): GitResponse {
  const lines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const entry of report) {
    if (entry.ref === '') continue;
    lines.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  // The report stream ends with its own flush packet INSIDE the band-1 payload: a real
  // git client parses the report as a pkt-line stream and dies with "the remote end hung
  // up unexpectedly" on EOF without it (the outer sideband flush does not count).
  lines.push(FLUSH);
  const stream = Buffer.concat(lines);
  const body = Buffer.concat([sidebandWrap(1, stream), FLUSH]);
  return ok('application/x-git-receive-pack-result', body);
}

// -------------------------------------------------------------------------------------------
// entry points
// -------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, protocol: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return err(404, 'Not Found');
  if (protocol === '2') {
    const parsed = parseV2Request(body);
    if (!parsed) return err(400, 'malformed v2 request');
    if (parsed.command === 'ls-refs') return handleLsRefs(repo, parsed.args);
    if (parsed.command === 'fetch') return handleFetchV2(store, repo, parsed.args);
    return err(400, `unknown v2 command ${parsed.command}`);
  }
  return handleUploadPackV0(store, repo, body);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePackRequest(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return err(404, 'Not Found');
  return handleReceivePack(store, repo, body);
}

export { VIEWER_LOGIN };
