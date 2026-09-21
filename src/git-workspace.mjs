import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest, safePath, assertContained} from './contracts.mjs';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const absolute = (value, name) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error(`${name} must be absolute`);
  const resolved = path.resolve(value);
  assertContained(path.parse(resolved).root, resolved);
  return resolved;
};
const nul = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

// Every invocation owns its temporary index and empty hooks directory. No repository config is edited.
function withGit(directory, action) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-git-index-'));
  const emptyConfig = path.join(temporary, 'empty-config');
  fs.writeFileSync(emptyConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1'});
  const config = [
    '-c', `core.hooksPath=${temporary}`, '-c', 'core.fsmonitor=false',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.eol=lf', '-c', 'core.longpaths=true',
    '-c', 'submodule.recurse=false', '-c', `core.attributesFile=${emptyConfig}`,
  ];
  const git = (args, {cwd = directory, index = false, input, allowFailure = false} = {}) => {
    const result = spawnSync('git', ['--no-pager', ...config, '-C', cwd, ...args], {
      env: index ? {...env, GIT_INDEX_FILE: path.join(temporary, 'index')} : env,
      input, windowsHide: true, shell: false, timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) throw Error(`Git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`);
    return result;
  };
  try {
    // .gitattributes may name drivers from local or worktree config; neutralize every configured filter.
    const drivers = git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {allowFailure: true});
    if (![0, 1].includes(drivers.status)) throw Error(`Cannot inspect Git filters: ${drivers.stderr.toString('utf8').trim()}`);
    for (const key of new Set(nul(drivers.stdout))) config.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    return action(git);
  } finally {
    const relative = path.relative(os.tmpdir(), temporary);
    if (!relative.startsWith('workbench-git-index-') || relative.includes(path.sep)) throw Error('Refusing to remove an unexpected temporary directory');
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

const text = (git, args, options) => git(args, options).stdout.toString('utf8').trim();
const status = (git, cwd) => git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {cwd}).stdout.toString('utf8');
const rootOf = (git, cwd) => path.resolve(text(git, ['rev-parse', '--show-toplevel'], {cwd}));
const commit = (git, ref, cwd) => text(git, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {cwd});

/** Create a detached worktree from a commit; the source worktree and its index are never reset. */
export function createWorkspace({repository, directory, ref = 'HEAD'} = {}) {
  repository = absolute(repository, 'repository');
  directory = absolute(directory, 'directory');
  if (fs.existsSync(directory)) throw Error('Workspace directory already exists; preserve it');
  if (typeof ref !== 'string' || !ref || /[\0\r\n]/.test(ref)) throw Error('A valid Git ref is required');
  return withGit(repository, git => {
    repository = rootOf(git, repository);
    if (inside(repository, directory)) throw Error('Workspace directory must be outside the source worktree');
    const baseCommit = commit(git, ref, repository);
    const repositoryHead = commit(git, 'HEAD', repository);
    const repositoryStatus = status(git, repository);
    fs.mkdirSync(path.dirname(directory), {recursive: true});
    fs.mkdirSync(directory); // Reserve exclusively; Git otherwise permits an existing empty directory.
    git(['worktree', 'add', '--detach', '--', directory, baseCommit], {cwd: repository});
    if (!samePath(rootOf(git, directory), directory) || commit(git, 'HEAD', directory) !== baseCommit) throw Error('Created worktree does not match the requested base; preserve it for review');
    if (commit(git, 'HEAD', repository) !== repositoryHead || status(git, repository) !== repositoryStatus) throw Error('Source repository changed during worktree creation; preserve both worktrees for review');
    return {repository, directory, baseCommit, repositoryHead, repositoryStatus};
  });
}

function allowedPaths(directory, allowedFiles) {
  if (!Array.isArray(allowedFiles) || !allowedFiles.length) throw Error('An exact allowedFiles whitelist is required');
  const seen = new Set();
  for (const file of allowedFiles) {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some(part => part.toLowerCase() === '.git')) throw Error('Allowed files must be exact Git-relative file paths');
    const resolved = safePath(directory, file);
    if (fs.existsSync(resolved) && !fs.lstatSync(resolved).isFile()) throw Error(`Allowed path must be a file, not a directory: ${file}`);
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) throw Error('Duplicate allowed file');
    seen.add(key);
  }
  return new Set(allowedFiles);
}

function changesFrom(bytes) {
  const fields = nul(bytes), changes = [];
  for (let i = 0; i < fields.length;) {
    const code = fields[i++], first = fields[i++];
    if (!first) throw Error('Invalid Git change record');
    if (/^[RC]/.test(code)) {
      const next = fields[i++];
      if (!next) throw Error('Invalid Git rename record');
      changes.push({status: code[0] === 'R' ? 'renamed' : 'copied', oldPath: first, path: next});
    } else changes.push({status: ({A: 'added', D: 'deleted', M: 'modified', T: 'type-changed'})[code] ?? code, path: first});
  }
  return changes;
}

function inspect(git, options) {
  const {directory, baseCommit, repository, repositoryHead, allowedFiles} = options;
  if (!samePath(rootOf(git, directory), directory)) throw Error('directory must be the exact Git worktree root');
  if (!fs.lstatSync(path.join(directory, '.git')).isFile()) throw Error('Expected a linked worktree created for this run');
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw Error('baseCommit must be a full commit hash');
  if (commit(git, baseCommit, directory) !== baseCommit) throw Error('Base commit mismatch');
  const allowed = allowedPaths(directory, allowedFiles);
  const head = commit(git, 'HEAD', directory);
  let sourceHead = null;
  if (repository !== undefined) {
    if (!samePath(rootOf(git, repository), repository)) throw Error('repository must be the original Git root');
    const common = cwd => path.resolve(cwd, text(git, ['rev-parse', '--git-common-dir'], {cwd}));
    if (!samePath(common(repository), common(directory))) throw Error('Workspace belongs to a different repository');
    sourceHead = commit(git, 'HEAD', repository);
  }
  const actualChanges = new Set([
    ...nul(git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit, '--']).stdout),
    ...nul(git(['ls-files', '--others', '--exclude-standard', '-z']).stdout),
  ]);
  // Validate changed paths before any content enters the temporary index.
  for (const file of actualChanges) safePath(directory, file);
  const baseFiles = new Set(nul(git(['ls-tree', '-r', '--name-only', '-z', baseCommit, '--']).stdout));
  for (const file of allowed) if ([...baseFiles].some(base => base.startsWith(file + '/'))) throw Error(`Allowed path names a directory in the base commit: ${file}`);
  const stage = [...allowed].filter(file => baseFiles.has(file) || fs.existsSync(safePath(directory, file)));
  git(['read-tree', baseCommit], {index: true});
  if (stage.length) git(['add', '--all', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {index: true, input: Buffer.from(stage.join('\0') + '\0')});
  const changes = changesFrom(git(['diff', '--cached', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', baseCommit, '--'], {index: true}).stdout);
  const unexpectedFiles = [...actualChanges].filter(file => !allowed.has(file)).sort();
  const changedFiles = [...new Set([...changes.flatMap(item => item.oldPath ? [item.oldPath, item.path] : [item.path]), ...unexpectedFiles])].sort();
  return {
    changedFiles, unexpectedFiles, changes, baseCommit, head,
    headChanged: head !== baseCommit, sourceHead,
    sourceHeadChanged: repositoryHead === undefined ? null : sourceHead !== repositoryHead,
    ignoredFilesPolicy: 'Untracked ignored files outside allowedFiles are excluded; allowed ignored files are included.',
  };
}

function normalized(options = {}) {
  return {...options, directory: absolute(options.directory, 'directory'), ...(options.repository === undefined ? {} : {repository: absolute(options.repository, 'repository')})};
}

/** Inspect current bytes using a private index; ignored runtime caches outside the whitelist are excluded. */
export function inspectWorkspace(options) {
  options = normalized(options);
  return withGit(options.directory, git => inspect(git, options));
}

/** Export a binary-capable patch without committing, merging, pushing, or changing either real index. */
export function exportPatch(options = {}) {
  options = normalized(options);
  const outputPath = absolute(options.outputPath, 'outputPath');
  if (fs.existsSync(outputPath)) throw Error('Patch output already exists; preserve it');
  if (inside(options.directory, outputPath) || (options.repository && inside(options.repository, outputPath))) throw Error('Patch output must be outside both worktrees');
  return withGit(options.directory, git => {
    const inspected = inspect(git, options);
    if (inspected.headChanged) throw Error('Workspace HEAD changed; agent commits require review');
    if (inspected.sourceHeadChanged) throw Error('Source repository HEAD changed; reconcile before delivery');
    if (inspected.unexpectedFiles.length) throw Error(`Unexpected files outside the whitelist: ${inspected.unexpectedFiles.join(', ')}`);
    const patch = git(['diff', '--cached', '--binary', '--full-index', '--find-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', options.baseCommit, '--'], {index: true}).stdout;
    // A concurrent agent must not change the inspected checkout between staging and export.
    const checkedAgain = inspect(git, options);
    const currentPatch = git(['diff', '--cached', '--binary', '--full-index', '--find-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', options.baseCommit, '--'], {index: true}).stdout;
    if (checkedAgain.headChanged || checkedAgain.sourceHeadChanged || checkedAgain.unexpectedFiles.length || !patch.equals(currentPatch)) throw Error('Workspace changed during patch export; preserve it and inspect again');
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    fs.writeFileSync(outputPath, patch, {flag: 'wx'});
    return {path: outputPath, sha256: digest(patch), changedFiles: inspected.changedFiles};
  });
}
