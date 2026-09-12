import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configFrom, digest, writeJson } from '../src/contracts.mjs';
import { advance, getPacket, knowledge, prepare, status } from '../src/workflow.mjs';

function fixture(t) {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'workbench-obsidian-config-'));
  const created = fs.lstatSync(root);
  const projectRoot = path.join(root, 'project');
  const cfg = {
    projectId: 'obsidian-fixture', projectRoot,
    controlRoot: path.join(projectRoot, 'control'),
    workRoot: path.join(projectRoot, 'work'),
    vaultRoot: path.join(projectRoot, 'knowledge'),
    maxWorkers: 1, model: 'gpt-5.5', thinking: 'low', captureEnabled: true,
    pmThreadId: '11111111-1111-4111-8111-111111111111', workerThreads: {},
  };
  fs.mkdirSync(cfg.workRoot, { recursive: true });
  const instances = [];
  t.after(() => {
    for (const instance of instances) instance.close();
    const relative = path.relative(temporaryRoot, root);
    const current = fs.lstatSync(root);
    assert.ok(relative.startsWith('workbench-obsidian-config-') && !relative.includes(path.sep));
    assert.equal(path.dirname(root), temporaryRoot);
    assert.equal(fs.realpathSync.native(root), root);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, created.dev);
    assert.equal(current.ino, created.ino);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const load = (overrides = {}, name = 'project.json') => {
    const filename = path.join(root, name);
    writeJson(filename, { ...cfg, ...overrides });
    return configFrom(filename);
  };
  const open = options => {
    const instance = knowledge(options);
    instances.push(instance);
    return instance;
  };
  const vaultRoot = path.join(root, 'obsidian', '项目知识', '恋语');
  return {
    root, cfg, load, open,
    external: { vaultRoot, externalVaultRoot: vaultRoot, knowledgeIndexFile: 'knowledge-obsidian.sqlite' },
  };
}

test('external vaults stay closed by default and require an exact absolute grant', t => {
  const f = fixture(t);
  assert.equal(f.load().knowledgeIndexFile, 'knowledge.sqlite');
  assert.throws(() => f.load({ vaultRoot: f.external.vaultRoot }));
  for (const externalVaultRoot of [path.join(f.root, 'other'), 'relative-vault', '', null]) {
    assert.throws(() => f.load({ ...f.external, externalVaultRoot }));
  }
  assert.equal(fs.existsSync(f.external.vaultRoot), false);
  const authorized = f.load({ ...f.external, externalVaultRoot: path.join(f.external.vaultRoot, '.') });
  assert.equal(authorized.vaultRoot, f.external.vaultRoot);
  assert.equal(authorized.externalVaultRoot, f.external.vaultRoot);
});

test('an authorized external vault captures and searches the same readable Markdown through a separate cache', t => {
  const f = fixture(t);
  const original = f.load();
  const old = f.open(original);
  old.sync();
  old.close();
  const oldIndex = path.join(original.controlRoot, 'knowledge.sqlite');
  const oldBytes = fs.readFileSync(oldIndex);
  const statePath = path.join(original.controlRoot, 'state.sqlite');
  fs.writeFileSync(statePath, 'untouched state sentinel');
  const cfg = f.load(f.external);
  const evidence = path.join(cfg.projectRoot, 'seed.txt');
  fs.writeFileSync(evidence, 'authorized fixture evidence');
  const input = {
    id: 'shared-obsidian-note', title: '项目知识隔离', body: '恋语知识检索只读取授权项目目录。', kind: 'decision',
    source: { runId: 'seed', taskId: 'seed', evidence: [{ path: evidence, sha256: digest(fs.readFileSync(evidence)) }] },
  };
  const index = f.open(cfg);
  const saved = index.capture(input);
  assert.equal(path.dirname(saved.path), cfg.vaultRoot);
  const readable = path.join(cfg.vaultRoot, '恋语知识隔离.md');
  fs.renameSync(saved.path, readable);
  assert.deepEqual(index.capture(input), { ...saved, path: readable, reused: true });
  fs.appendFileSync(readable, '\n人工补充 obsidianunique。\n');
  const result = index.search('obsidianunique');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, input.id);
  assert.equal(result.items[0].path, readable);
  assert.equal(result.items[0].hash, digest(fs.readFileSync(readable)));
  assert.match(result.items[0].text, /人工补充 obsidianunique/);
  assert.deepEqual(fs.readdirSync(cfg.vaultRoot).filter(name => name.endsWith('.md')), ['恋语知识隔离.md']);
  assert.equal(fs.existsSync(path.join(cfg.controlRoot, cfg.knowledgeIndexFile)), true);
  assert.deepEqual(fs.readFileSync(oldIndex), oldBytes);
  assert.equal(fs.readFileSync(statePath, 'utf8'), 'untouched state sentinel');
});

test('external vault authorization never permits an external work or control root', t => {
  const f = fixture(t);
  for (const key of ['workRoot', 'controlRoot']) {
    assert.throws(() => f.load({ ...f.external, [key]: path.join(f.root, `external-${key}`) }));
  }
});

test('knowledge cache names cannot select state, paths, streams, or non-SQLite files', t => {
  const f = fixture(t);
  for (const knowledgeIndexFile of [
    'state.sqlite', '../knowledge.sqlite', path.join(f.root, 'knowledge.sqlite'),
    'knowledge.sqlite-journal', 'knowledge-Obsidian.sqlite', 'knowledge-obsidian.db',
    'knowledge.sqlite:secret', 'knowledge_.sqlite', 'knowledge.sqlite\n', 42,
  ]) {
    assert.throws(() => f.load({ ...f.external, knowledgeIndexFile }), String(knowledgeIndexFile));
    assert.throws(() => knowledge({ ...f.cfg, knowledgeIndexFile }), String(knowledgeIndexFile));
    assert.equal(fs.existsSync(f.cfg.controlRoot), false);
  }
  assert.equal(f.load({ ...f.external, knowledgeIndexFile: 'knowledge-obsidian-20260912.sqlite' }).knowledgeIndexFile, 'knowledge-obsidian-20260912.sqlite');
  assert.equal(fs.existsSync(f.cfg.controlRoot), false);
});

test('an exact external grant cannot authorize a junction or symlink ancestor', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'real-obsidian');
  const link = path.join(f.root, 'linked-obsidian');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const vaultRoot = path.join(link, '项目知识', '恋语');
    assert.throws(() => f.load({ ...f.external, vaultRoot, externalVaultRoot: vaultRoot }), /symlink|junction/i);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    assert.equal(path.dirname(link), f.root);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    fs.unlinkSync(link);
  }
});

test('a completed run remains bound to its saved configuration after knowledge migration', async t => {
  const f = fixture(t);
  const original = f.load({}, 'original-project.json');
  const request = {
    id: 'before-migration', objective: 'complete an isolated fixture', mode: 'direct', reason: 'verify migration identity',
    tasks: [{ id: 'A', objective: 'write one accepted fixture', files: ['result.txt'] }],
    checks: [{ id: 'result', command: 'node', args: ['--input-type=module', '-e', "import {readFileSync} from 'node:fs';if(readFileSync('result.txt','utf8')!=='accepted fixture')process.exit(1)"] }],
  };
  prepare(original, request);
  await advance(original, request.id);
  const packet = getPacket(original, request.id, 'A');
  fs.writeFileSync(packet.files[0], 'accepted fixture');
  writeJson(packet.receiptPath, { runId: request.id, taskId: 'A', attemptId: packet.attemptId, status: 'done', summary: 'fixture written', knowledgeIds: [] });
  const completed = await advance(original, request.id);
  assert.equal(completed.status, 'COMPLETE');
  assert.equal(completed.acceptance.verified, true);
  const acceptancePath = path.join(original.controlRoot, 'runs', request.id, 'acceptance.json');
  const acceptanceBefore = fs.readFileSync(acceptancePath);
  const row = () => {
    const db = new DatabaseSync(path.join(original.controlRoot, 'state.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT identity,status,acceptance_hash FROM runs WHERE id=?').get(request.id); }
    finally { db.close(); }
  };
  const before = row();
  const migrated = f.load(f.external, 'migrated-project.json');
  const rebuilt = f.open(migrated);
  assert.equal(rebuilt.sync().total, 0);
  assert.throws(() => status(migrated, request.id), /configuration changed/);
  const saved = configFrom(path.join(f.root, 'original-project.json'));
  const historical = status(saved, request.id);
  assert.equal(historical.status, 'COMPLETE');
  assert.equal(historical.acceptance.verified, true);
  assert.deepEqual(row(), before);
  assert.deepEqual(fs.readFileSync(acceptancePath), acceptanceBefore);
  assert.equal(fs.readFileSync(packet.files[0], 'utf8'), 'accepted fixture');
});
