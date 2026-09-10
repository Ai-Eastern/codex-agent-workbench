import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const NOTE_BYTES = 512 * 1024;
const SCAN_BYTES = 64 * 1024 * 1024;
const EVIDENCE_BYTES = 32 * 1024 * 1024;
const MARKER = 'codex_workbench: ';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function string(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) {
    fail('KNOWLEDGE_INPUT', `Invalid ${name}`);
  }
  return value;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function key(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function cleanPath(value, name, absolute = true) {
  string(value, name, 32768);
  if ((absolute && !path.isAbsolute(value)) || value.split(/[\\/]/u).includes('..') || /^\\\\[?.]\\/u.test(value)) {
    fail('KNOWLEDGE_PATH', `${name} must be an explicit path without traversal or device aliases`);
  }
  const rest = path.isAbsolute(value) ? value.slice(path.parse(value).root.length) : value;
  if (rest.includes(':')) fail('KNOWLEDGE_PATH', `${name} must not contain drive-relative paths or alternate streams`);
  return value;
}

// Reject links in every ancestor, including Windows junctions, before opening files.
function safePath(value, { missing = false, directory = false } = {}) {
  const absolute = path.resolve(cleanPath(value, 'path'));
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = path.join(current, parts[i - 1]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT' && missing) return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('KNOWLEDGE_PATH', `Symbolic links and junctions are not authorized: ${current}`);
    if ((i < parts.length || directory) && !stat.isDirectory()) fail('KNOWLEDGE_PATH', `Expected directory: ${current}`);
  }
  if (key(realpathSync.native(absolute)) !== key(absolute)) fail('KNOWLEDGE_PATH', `Path aliases are not authorized: ${absolute}`);
  return absolute;
}

function beneath(root, value, name) {
  cleanPath(value, name, false);
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('KNOWLEDGE_PATH', `${name} must be a file below its authorized root`);
  }
  return safePath(absolute);
}

function readFile(value, maximum, budget, digestOnly = false) {
  safePath(value);
  const before = lstatSync(value);
  if (!before.isFile()) fail('KNOWLEDGE_PATH', `Expected regular file: ${value}`);
  if (before.size > maximum || (budget && before.size > budget.remaining)) fail('KNOWLEDGE_LIMIT', `Read limit exceeded: ${value}`);
  const fd = openSync(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) fail('KNOWLEDGE_PATH', `File changed while opening: ${value}`);
    const digest = createHash('sha256');
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1));
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - total), null);
      if (!count) break;
      total += count;
      if (total > maximum || (budget && total > budget.remaining)) fail('KNOWLEDGE_LIMIT', `Read limit exceeded: ${value}`);
      digest.update(buffer.subarray(0, count));
      if (!digestOnly) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(fd);
    if (after.size !== total || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      fail('KNOWLEDGE_CONFLICT', `File changed while reading: ${value}`);
    }
    if (budget) budget.remaining -= total;
    return { hash: digest.digest('hex'), text: digestOnly ? undefined : Buffer.concat(chunks).toString('utf8') };
  } finally { closeSync(fd); }
}

// Lexical retrieval: Unicode words plus Han characters/bigrams, with no embedding model.
function tokens(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const result = [];
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(match[0]);
    for (const character of chars) result.push(character);
    for (let i = 0; i + 1 < chars.length; i++) result.push(chars[i] + chars[i + 1]);
  }
  for (const word of normalized.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}_]+/gu) ?? []) result.push(word);
  return result;
}

function metadata(text) {
  const normalized = text.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith(`---\n${MARKER}`)) return null;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) fail('KNOWLEDGE_METADATA', 'Malformed capture metadata');
  let data;
  try { data = JSON.parse(normalized.slice(4 + MARKER.length, end)); } catch {
    fail('KNOWLEDGE_METADATA', 'Malformed capture metadata');
  }
  if (!data || data.version !== 1) fail('KNOWLEDGE_METADATA', 'Unsupported capture metadata');
  string(data.id, 'capture id');
  string(data.projectId, 'capture projectId');
  string(data.title, 'capture title');
  string(data.kind, 'capture kind');
  return { ...data, body: normalized.slice(end + 5) };
}

export function createKnowledge({ projectId, vaultRoot, indexPath, sourceRoot } = {}) {
  string(projectId, 'projectId');
  cleanPath(vaultRoot, 'vaultRoot');
  cleanPath(indexPath, 'indexPath');
  cleanPath(sourceRoot, 'sourceRoot');
  const vault = safePath(vaultRoot, { missing: true, directory: true });
  const source = safePath(sourceRoot, { directory: true });
  const index = safePath(indexPath, { missing: true });
  if (/\.md$/iu.test(index)) fail('KNOWLEDGE_PATH', 'The derived index cannot be a Markdown file');
  mkdirSync(vault, { recursive: true });
  safePath(vault, { directory: true });
  safePath(path.dirname(index), { missing: true, directory: true });
  mkdirSync(path.dirname(index), { recursive: true });
  const lockPath = path.join(vault, '.codex-knowledge.lock');
  let db;
  let closed = false;

  function roots() {
    if (closed) fail('KNOWLEDGE_CLOSED', 'Knowledge instance is closed');
    safePath(vault, { directory: true });
    safePath(source, { directory: true });
    for (const filename of [index, `${index}-journal`, `${index}-wal`, `${index}-shm`]) safePath(filename, { missing: true });
  }

  function locked(action) {
    roots();
    safePath(lockPath, { missing: true });
    let fd;
    try { fd = openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') fail('KNOWLEDGE_LOCKED', `Knowledge writer is locked: ${lockPath}`);
      throw error;
    }
    const identity = fstatSync(fd);
    try {
      writeFileSync(fd, JSON.stringify({ projectId, pid: process.pid, token: randomUUID() }));
      return action();
    } finally {
      closeSync(fd);
      // Never remove a lock replaced by another owner; abandoned locks need explicit recovery.
      if (existsSync(lockPath)) {
        const current = lstatSync(lockPath);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
      }
    }
  }

  locked(() => {
    db = new DatabaseSync(index);
    try {
      db.exec(`PRAGMA busy_timeout=0;
        CREATE TABLE IF NOT EXISTS knowledge_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, kind TEXT, source TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, body);`);
      const identity = JSON.stringify({ version: 1, projectId, vaultRoot: key(vault), sourceRoot: key(source) });
      const existing = db.prepare('SELECT identity FROM knowledge_identity WHERE singleton=1').get();
      if (existing && existing.identity !== identity) fail('KNOWLEDGE_PROJECT', 'Index belongs to a different project or authorized root');
      if (!existing) db.prepare('INSERT INTO knowledge_identity VALUES (1, ?)').run(identity);
    } catch (error) { db.close(); throw error; }
  });

  function validateSource(input, budget = { remaining: SCAN_BYTES }, cache = new Map()) {
    if (!input || typeof input !== 'object') fail('KNOWLEDGE_INPUT', 'capture source is required');
    string(input.runId, 'source.runId');
    string(input.taskId, 'source.taskId');
    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 32) fail('KNOWLEDGE_INPUT', 'source.evidence must contain 1 to 32 files');
    const evidence = input.evidence.map(item => {
      if (!item || typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(item.sha256)) fail('KNOWLEDGE_INPUT', 'Invalid evidence sha256');
      const filename = beneath(source, item.path, 'evidence.path');
      let actual = cache.get(filename);
      if (!actual) {
        actual = readFile(filename, EVIDENCE_BYTES, budget, true).hash;
        cache.set(filename, actual);
      }
      if (actual !== item.sha256.toLowerCase()) fail('KNOWLEDGE_SOURCE_STALE', `Evidence sha256 no longer matches: ${filename}`);
      return { path: path.relative(source, filename).split(path.sep).join('/'), sha256: actual };
    });
    return { runId: input.runId, taskId: input.taskId, evidence };
  }

  function scan() {
    const documents = [];
    const ids = new Set();
    const budget = { remaining: SCAN_BYTES };
    const evidenceCache = new Map();
    let visited = 0;
    let skipped = 0;
    let invalidSources = 0;
    function walk(directory) {
      safePath(directory, { directory: true });
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 10000) fail('KNOWLEDGE_LIMIT', 'Vault exceeds 10000 entries');
        const filename = path.join(directory, entry.name);
        const stat = lstatSync(filename);
        if (stat.isSymbolicLink()) fail('KNOWLEDGE_PATH', `Symbolic links and junctions are not authorized: ${filename}`);
        if (stat.isDirectory()) { walk(filename); continue; }
        if (!/\.md$/iu.test(entry.name)) { skipped++; continue; }
        const content = readFile(filename, NOTE_BYTES, budget);
        const meta = metadata(content.text);
        if (meta && meta.projectId !== projectId) { skipped++; continue; }
        const relative = path.relative(vault, filename).split(path.sep).join('/');
        const id = meta?.id ?? `file:${hash(relative)}`;
        if (ids.has(id)) fail('KNOWLEDGE_CONFLICT', `Duplicate Markdown knowledge id: ${id}`);
        ids.add(id);
        let validatedSource;
        let valid = true;
        if (meta) {
          try { validatedSource = validateSource(meta.source, budget, evidenceCache); } catch (error) {
            if (['KNOWLEDGE_LIMIT', 'KNOWLEDGE_CONFLICT'].includes(error.code)) throw error;
            valid = false;
            invalidSources++;
          }
        }
        const title = meta?.title ?? (content.text.match(/^#\s+(.+)$/mu)?.[1] ?? path.basename(filename, path.extname(filename))).slice(0, 200);
        documents.push({ id, path: filename, title, hash: content.hash, text: meta?.body ?? content.text, kind: meta?.kind ?? 'note', source: validatedSource, valid });
      }
    }
    walk(vault);
    return { documents, skipped, invalidSources };
  }

  function syncInside() {
    const { documents, skipped, invalidSources } = scan();
    const existing = new Map(db.prepare('SELECT id, path, hash FROM knowledge_documents').all().map(row => [row.id, row]));
    const counts = { projectId, indexed: 0, updated: 0, deleted: 0, unchanged: 0, skipped, invalidSources, total: 0 };
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const document of documents.filter(item => item.valid)) {
        counts.total++;
        const prior = existing.get(document.id);
        existing.delete(document.id);
        if (prior?.hash === document.hash && prior.path === document.path) { counts.unchanged++; continue; }
        db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(document.id);
        db.prepare(`INSERT INTO knowledge_documents (id,path,title,hash,text,kind,source) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET path=excluded.path,title=excluded.title,hash=excluded.hash,text=excluded.text,kind=excluded.kind,source=excluded.source`)
          .run(document.id, document.path, document.title, document.hash, document.text, document.kind, document.source ? JSON.stringify(document.source) : null);
        db.prepare('INSERT INTO knowledge_fts (id,title,body) VALUES (?,?,?)').run(document.id, tokens(document.title).join(' '), tokens(document.text).join(' '));
        counts[prior ? 'updated' : 'indexed']++;
      }
      for (const id of existing.keys()) {
        db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(id);
        db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id);
        counts.deleted++;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return counts;
  }

  return {
    sync() { return locked(syncInside); },
    search(query, { limit = 5, maxChars = 6000 } = {}) {
      if (typeof query !== 'string' || query.length > 2048) fail('KNOWLEDGE_LIMIT', 'Query must be a string of at most 2048 characters');
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxChars) || maxChars < 0 || maxChars > 100000) {
        fail('KNOWLEDGE_LIMIT', 'limit must be 1 to 50; maxChars must be 0 to 100000');
      }
      return locked(() => {
        // ponytail: hash-scan the bounded vault on each query; add a watcher only after measured need.
        syncInside();
        const terms = [...new Set(tokens(query))].slice(0, 128);
        const result = { projectId, query, items: [], chars: 0 };
        if (!terms.length || !maxChars) return result;
        const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
        const rows = db.prepare(`SELECT d.* FROM knowledge_fts f JOIN knowledge_documents d ON d.id=f.id
          WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts,0,5,1),d.path LIMIT ?`).all(match, limit);
        for (const row of rows) {
          const text = row.text.slice(0, maxChars - result.chars);
          if (!text) break;
          result.items.push({ id: row.id, title: row.title, path: row.path, hash: row.hash, text, kind: row.kind, source: row.source ? JSON.parse(row.source) : null });
          result.chars += text.length;
        }
        return result;
      });
    },
    capture({ id, title, body, kind, source: inputSource, expectedHash } = {}) {
      string(id, 'id');
      if (id.startsWith('file:')) fail('KNOWLEDGE_INPUT', 'The file: id prefix is reserved for ordinary Markdown');
      string(title, 'title');
      string(kind, 'kind');
      if (typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024) fail('KNOWLEDGE_LIMIT', 'Capture body must be text of at most 256 KiB');
      if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f\d]{64}$/iu.test(expectedHash))) fail('KNOWLEDGE_INPUT', 'Invalid expectedHash');
      return locked(() => {
        const verified = validateSource(inputSource);
        const meta = { version: 1, projectId, id, title, kind, source: verified };
        const markdown = `---\n${MARKER}${JSON.stringify(meta)}\n---\n# ${title}\n\n${body.replace(/\r\n/gu, '\n')}\n`;
        if (Buffer.byteLength(markdown) > NOTE_BYTES) fail('KNOWLEDGE_LIMIT', 'Capture metadata and body exceed note limit');
        const desiredHash = hash(markdown);
        const found = scan().documents.find(document => document.id === id);
        const filename = found?.path ?? path.join(vault, `capture-${hash(id)}.md`);
        safePath(filename, { missing: true });
        const prior = existsSync(filename) ? readFile(filename, NOTE_BYTES) : null;
        const priorMetadata = prior ? metadata(prior.text) : null;
        if (priorMetadata && (priorMetadata.projectId !== projectId || priorMetadata.id !== id)) fail('KNOWLEDGE_PROJECT', 'Capture path belongs to another project or id');
        if (prior?.hash === desiredHash) return { id, path: filename, hash: desiredHash, reused: true };
        if (prior && expectedHash?.toLowerCase() !== prior.hash) fail('KNOWLEDGE_CONFLICT', `Existing Markdown changed; supply its current expectedHash: ${filename}`);
        if (!prior && expectedHash !== undefined) fail('KNOWLEDGE_CONFLICT', 'expectedHash was supplied but the Markdown no longer exists');
        const temporary = path.join(path.dirname(filename), `.codex-capture-${randomUUID()}.tmp`);
        let fd;
        try {
          fd = openSync(temporary, 'wx', 0o600);
          writeFileSync(fd, markdown);
          fsyncSync(fd);
          closeSync(fd);
          fd = undefined;
          roots();
          safePath(filename, { missing: true });
          const latest = existsSync(filename) ? readFile(filename, NOTE_BYTES).hash : null;
          if (latest !== (prior?.hash ?? null)) fail('KNOWLEDGE_CONFLICT', 'Markdown changed before capture commit');
          renameSync(temporary, filename);
        } finally {
          if (fd !== undefined) closeSync(fd);
          if (existsSync(temporary)) unlinkSync(temporary);
        }
        // Markdown is authoritative. A future sync derives the index, including after a process interruption.
        return { id, path: filename, hash: desiredHash, reused: false };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
