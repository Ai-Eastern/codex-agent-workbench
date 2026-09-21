import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWorkspace, inspectWorkspace, exportPatch} from '../src/git-workspace.mjs';
import {digest} from '../src/contracts.mjs';

function git(directory, args, allowFailure = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {GIT_CONFIG_GLOBAL: path.join(directory, '..', 'empty-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0'});
  const result = spawnSync('git', ['-c', 'user.name=Public Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-C', directory, ...args], {env, windowsHide: true, encoding: 'utf8'});
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return result;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-git-fixture-'));
  const repository = path.join(root, 'source');
  const workspaces = [];
  t.after(() => {
    for (const workspace of workspaces.reverse()) git(repository, ['-c', 'core.hooksPath=', 'worktree', 'remove', '--force', workspace], true);
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('workbench-git-fixture-') && !relative.includes(path.sep));
    fs.rmSync(root, {recursive: true, force: true});
  });
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(root, 'empty-global-config'), '');
  git(repository, ['init', '--quiet']);
  for (const [file, content] of Object.entries({'tracked.txt': 'base\n', 'staged.txt': 'base stage\n', 'removed.txt': 'remove me\n', 'rename-before.txt': 'rename exactly\n', '.gitignore': 'cache/\n'})) fs.writeFileSync(path.join(repository, file), content);
  fs.writeFileSync(path.join(repository, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', 'public fixture baseline']);
  const create = (name = 'workspace', ref) => {
    const directory = path.join(root, name);
    const workspace = createWorkspace({repository, directory, ...(ref ? {ref} : {})});
    workspaces.push(directory);
    return workspace;
  };
  return {root, repository, create};
}

test('detached worktree and binary patch preserve the original dirty checkout and both real indexes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repository, 'tracked.txt'), 'user uncommitted work\n');
  fs.writeFileSync(path.join(f.repository, 'staged.txt'), 'user staged work\n');
  git(f.repository, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(f.repository, 'user-local.txt'), 'user untracked work\n');
  const originalStatus = git(f.repository, ['status', '--porcelain=v1', '-z']).stdout;
  const originalIndex = fs.readFileSync(path.join(f.repository, '.git/index'));
  const workspace = f.create();
  assert.equal(workspace.repositoryStatus, originalStatus);
  assert.equal(git(workspace.directory, ['symbolic-ref', '-q', 'HEAD'], true).status, 1);
  assert.equal(fs.readFileSync(path.join(workspace.directory, 'tracked.txt'), 'utf8'), 'base\n');
  const realIndex = path.resolve(workspace.directory, git(workspace.directory, ['rev-parse', '--git-path', 'index']).stdout.trim());
  const indexBytes = fs.readFileSync(realIndex);
  fs.writeFileSync(path.join(workspace.directory, 'tracked.txt'), 'agent fix\n');
  fs.writeFileSync(path.join(workspace.directory, 'new 标签.txt'), 'new file\n');
  fs.writeFileSync(path.join(workspace.directory, 'literal[1].txt'), 'literal pathspec\n');
  fs.unlinkSync(path.join(workspace.directory, 'removed.txt'));
  fs.renameSync(path.join(workspace.directory, 'rename-before.txt'), path.join(workspace.directory, 'rename-after.txt'));
  fs.writeFileSync(path.join(workspace.directory, 'binary.bin'), Buffer.from([0, 255, 3, 2, 128, 10]));
  fs.mkdirSync(path.join(workspace.directory, 'cache'));
  fs.writeFileSync(path.join(workspace.directory, 'cache/approved.txt'), 'explicit ignored artifact\n');
  fs.writeFileSync(path.join(workspace.directory, 'cache/runtime-cache.txt'), 'untracked runtime cache\n');
  const allowedFiles = ['tracked.txt', 'new 标签.txt', 'literal[1].txt', 'removed.txt', 'rename-before.txt', 'rename-after.txt', 'binary.bin', 'cache/approved.txt'];
  const inspected = inspectWorkspace({...workspace, allowedFiles});
  assert.deepEqual(inspected.changedFiles, [...allowedFiles].sort());
  assert.deepEqual(inspected.unexpectedFiles, []);
  assert.equal(inspected.headChanged, false);
  assert.equal(inspected.sourceHeadChanged, false);
  assert.ok(inspected.changes.some(item => item.status === 'renamed' && item.oldPath === 'rename-before.txt' && item.path === 'rename-after.txt'));
  const outputPath = path.join(f.root, 'delivery.patch');
  const exported = exportPatch({...workspace, allowedFiles, outputPath});
  const patchBytes = fs.readFileSync(outputPath);
  assert.equal(exported.sha256, digest(patchBytes));
  assert.match(patchBytes.toString('utf8'), /GIT binary patch/);
  assert.deepEqual(fs.readFileSync(realIndex), indexBytes);
  assert.throws(() => exportPatch({...workspace, allowedFiles, outputPath}), /already exists/);
  const applyTarget = f.create('apply-target');
  git(applyTarget.directory, ['apply', '--check', outputPath]);
  git(applyTarget.directory, ['apply', outputPath]);
  for (const file of allowedFiles.filter(file => !['removed.txt', 'rename-before.txt'].includes(file))) assert.deepEqual(fs.readFileSync(path.join(applyTarget.directory, file)), fs.readFileSync(path.join(workspace.directory, file)));
  assert.equal(fs.existsSync(path.join(applyTarget.directory, 'removed.txt')), false);
  assert.equal(fs.existsSync(path.join(applyTarget.directory, 'rename-before.txt')), false);
  assert.equal(fs.existsSync(path.join(applyTarget.directory, 'cache/runtime-cache.txt')), false);
  assert.equal(git(f.repository, ['status', '--porcelain=v1', '-z']).stdout, originalStatus);
  assert.deepEqual(fs.readFileSync(path.join(f.repository, '.git/index')), originalIndex);
  assert.equal(fs.readFileSync(path.join(f.repository, 'tracked.txt'), 'utf8'), 'user uncommitted work\n');
  assert.equal(fs.readFileSync(path.join(f.repository, 'staged.txt'), 'utf8'), 'user staged work\n');
});

test('unexpected writes, changed HEAD and source HEAD drift prevent patch delivery', t => {
  const f = fixture(t), workspace = f.create();
  const options = {...workspace, allowedFiles: ['tracked.txt'], outputPath: path.join(f.root, 'must-not-exist.patch')};
  fs.writeFileSync(path.join(workspace.directory, 'unexpected 标签.txt'), 'outside assignment');
  assert.deepEqual(inspectWorkspace(options).unexpectedFiles, ['unexpected 标签.txt']);
  assert.throws(() => exportPatch(options), /Unexpected files/);
  fs.unlinkSync(path.join(workspace.directory, 'unexpected 标签.txt'));
  fs.writeFileSync(path.join(workspace.directory, '.gitignore'), '*\n');
  assert.deepEqual(inspectWorkspace(options).unexpectedFiles, ['.gitignore']);
  assert.throws(() => exportPatch(options), /Unexpected files/);
  fs.writeFileSync(path.join(workspace.directory, '.gitignore'), 'cache/\n');
  fs.writeFileSync(path.join(workspace.directory, 'tracked.txt'), 'committed agent change\n');
  git(workspace.directory, ['add', 'tracked.txt']);
  git(workspace.directory, ['commit', '--quiet', '-m', 'agent committed without permission']);
  assert.equal(inspectWorkspace(options).headChanged, true);
  assert.throws(() => exportPatch(options), /Workspace HEAD changed/);
  const second = f.create('source-drift');
  fs.writeFileSync(path.join(f.repository, 'tracked.txt'), 'new source commit\n');
  git(f.repository, ['add', 'tracked.txt']);
  git(f.repository, ['commit', '--quiet', '-m', 'source moved']);
  const secondOptions = {...second, allowedFiles: ['tracked.txt'], outputPath: options.outputPath};
  assert.equal(inspectWorkspace(secondOptions).sourceHeadChanged, true);
  assert.throws(() => exportPatch(secondOptions), /Source repository HEAD changed/);
  assert.equal(fs.existsSync(options.outputPath), false);
  const olderRef = f.create('explicit-older-ref', workspace.baseCommit);
  assert.notEqual(olderRef.baseCommit, olderRef.repositoryHead);
  assert.equal(inspectWorkspace({...olderRef, allowedFiles: ['tracked.txt']}).sourceHeadChanged, false);
});

test('workspace paths and exact file whitelist reject reuse, escape, directories and junctions', t => {
  const f = fixture(t), workspace = f.create();
  assert.throws(() => createWorkspace({repository: f.repository, directory: workspace.directory}), /already exists/);
  assert.throws(() => createWorkspace({repository: f.root, directory: path.join(f.root, 'non-repo')}), /Git rev-parse failed/);
  assert.throws(() => createWorkspace({repository: f.repository, directory: 'relative'}), /absolute/);
  assert.throws(() => createWorkspace({repository: f.repository, directory: path.join(f.repository, 'nested-worktree')}), /outside/);
  assert.throws(() => inspectWorkspace({...workspace, allowedFiles: ['../outside.txt']}), /Unsafe/);
  assert.throws(() => inspectWorkspace({...workspace, allowedFiles: ['.git/config']}), /exact/);
  fs.mkdirSync(path.join(workspace.directory, 'folder'));
  assert.throws(() => inspectWorkspace({...workspace, allowedFiles: ['folder']}), /not a directory/);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'fixture outside scope');
  fs.symlinkSync(outside, path.join(workspace.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectWorkspace({...workspace, allowedFiles: ['linked/secret.txt']}), /Symlink|junction/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'fixture outside scope');
});

test('Git hooks, configured filters and external diff programs do not execute', t => {
  const f = fixture(t);
  const markerCommand = 'node -e "require(\'fs\').writeFileSync(\'GIT_HELPER_EXECUTED\',\'bad\');process.stdin.pipe(process.stdout)"';
  fs.writeFileSync(path.join(f.repository, '.gitattributes'), '*.txt filter=fixture diff=fixture\n');
  git(f.repository, ['add', '.gitattributes']);
  git(f.repository, ['commit', '--quiet', '-m', 'fixture attributes']);
  for (const key of ['filter.fixture.clean', 'filter.fixture.smudge', 'filter.fixture.process', 'diff.fixture.command', 'diff.fixture.textconv']) git(f.repository, ['config', key, markerCommand]);
  git(f.repository, ['config', 'filter.fixture.required', 'true']);
  const hooks = path.join(f.root, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nprintf bad > GIT_HOOK_EXECUTED\n', {mode: 0o755});
  git(f.repository, ['config', 'core.hooksPath', hooks]);
  const workspace = f.create();
  fs.writeFileSync(path.join(workspace.directory, 'tracked.txt'), 'raw bytes preserved\n');
  const result = exportPatch({...workspace, allowedFiles: ['tracked.txt'], outputPath: path.join(f.root, 'safe.patch')});
  assert.match(fs.readFileSync(result.path, 'utf8'), /raw bytes preserved/);
  for (const directory of [f.repository, workspace.directory]) for (const file of ['GIT_HELPER_EXECUTED', 'GIT_HOOK_EXECUTED']) assert.equal(fs.existsSync(path.join(directory, file)), false);
});
