import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {begin, submitResult, advance, repairTask, getPacket, knowledge, delivery} from '../src/workflow.mjs';
import {digest, readJson, writeJson} from '../src/contracts.mjs';
import {main as workbench} from '../src/cli.mjs';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '..');
const fixturePM = '11111111-1111-4111-8111-111111111111';
const sourceHashes = () => Object.fromEntries([
  'scripts/evidence-lab.mjs', 'examples/evidence-lab/acceptance.mjs', 'package.json', 'package-lock.json',
  ...fs.readdirSync(path.join(repository, 'src')).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`),
].sort().map(file => [file, digest(fs.readFileSync(path.join(repository, file)))]));
const before = `export function normalizeLabels(labels) {
  return [...new Set(labels.map(label => label.trim().toLowerCase()).filter(Boolean))];
}
`;
const after = `export function normalizeLabels(labels) {
  return [...new Set(labels.map(label =>
    label.normalize('NFKC').trim().replace(/\\s+/gu, ' ').toLowerCase()
  ).filter(Boolean))];
}
`;

/** Run only public fixtures in a child process; never borrow the caller's Desktop identity. */
export async function runEvidenceLab({outputRoot} = {}) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw Error('outputRoot must be a new absolute directory');
  outputRoot = path.resolve(outputRoot);
  if (fs.existsSync(outputRoot)) throw Error('outputRoot already exists; preserve the previous evidence');
  // No credentials, personal Codex identity or Node preload hooks enter this subprocess.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'pathext'].includes(key.toLowerCase())));
  env.CODEX_THREAD_ID = fixturePM;
  await promisify(execFile)(process.execPath, [script, '--fixture', outputRoot], {
    cwd: repository, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  const reportPath = path.join(outputRoot, 'report.json');
  return {outputRoot, reportPath, report: readJson(reportPath)};
}

async function runFixture(outputRoot) {
  if (!path.isAbsolute(outputRoot) || process.env.CODEX_THREAD_ID !== fixturePM) throw Error('Isolated public fixture process required');
  const testedSource = sourceHashes();
  fs.mkdirSync(path.dirname(outputRoot), {recursive: true});
  fs.mkdirSync(outputRoot); // Atomic reservation: even an empty existing directory is refused.
  const cfg = {
    projectId: 'evidence-lab', projectRoot: outputRoot,
    workRoot: path.join(outputRoot, 'work'), controlRoot: path.join(outputRoot, 'control'),
    vaultRoot: path.join(outputRoot, 'knowledge'), pmThreadId: fixturePM, workerThreads: {},
    maxWorkers: 1, model: 'gpt-5.5', thinking: 'low', captureEnabled: true,
  };
  const configFile = path.join(outputRoot, 'project.json');
  writeJson(configFile, cfg);
  fs.mkdirSync(cfg.vaultRoot, {recursive: true});
  fs.writeFileSync(path.join(cfg.vaultRoot, 'label-contract.md'), '# 标签规范化约定\n\n标签先做 Unicode NFKC 规范化，再去除首尾空白、合并连续空白为一个空格、转为小写。过滤空标签，按第一次出现的顺序去重。\n');
  const acceptanceDirectory = path.join(outputRoot, 'acceptance');
  fs.mkdirSync(acceptanceDirectory);
  const verifier = path.join(acceptanceDirectory, 'acceptance.mjs');
  fs.copyFileSync(new URL('../examples/evidence-lab/acceptance.mjs', import.meta.url), verifier);
  const verifierHash = digest(fs.readFileSync(verifier));
  const executions = () => {
    const file = path.join(acceptanceDirectory, 'executions.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const search = () => {
    const index = knowledge(cfg);
    try { return index.search('标签 规范化', {limit: 5, maxChars: 3000}); } finally { index.close(); }
  };
  const stages = [], checks = [];
  const check = (id, title, passed, detail) => checks.push({id, title, passed: Boolean(passed), detail});
  const stage = (id, title, status, description, evidence) => stages.push({id, title, status, description, evidence});
  const request = {
    id: 'label-normalization', objective: '修复中文与全角标签的规范化和去重', mode: 'direct',
    reason: '公开确定性样例；两份预置补丁验证交付门禁，不调用模型。',
    tasks: [{id: 'normalize', objective: '实现标签规范化约定', files: ['normalize-labels.mjs'], knowledge: {query: '标签 规范化'}}],
    checks: [{id: 'label-contract', command: 'node', args: ['../acceptance/acceptance.mjs']}],
  };
  const started = await begin(cfg, request);
  const firstPacket = getPacket(cfg, request.id, 'normalize');
  const retrieved = firstPacket.context.items;
  check('knowledge-retrieval', '从项目知识取得带哈希的约定', retrieved.length > 0 && retrieved.every(item => item.hash), `${retrieved.length} 条知识进入真实任务包。`);
  stage('knowledge', '读取任务与项目约定', 'passed', '生产知识检索接口读取公开 Markdown，原文与 SHA-256 随任务包交付。', {runId: started.runId, items: retrieved});

  const artifact = firstPacket.files[0];
  fs.writeFileSync(artifact, before);
  submitResult(cfg, request.id, 'normalize', {expectedAttemptId: firstPacket.attemptId, summary: '预置错误补丁：仅 trim、小写与去重，等待真实验收。'});
  const failed = await advance(cfg, request.id);
  const failedReceiptBytes = fs.readFileSync(failed.acceptance.path);
  const failedAcceptance = JSON.parse(failedReceiptBytes);
  check('acceptance-rejected', '错误补丁被真实 Node 验收拒绝', failed.status === 'FAILED' && failedAcceptance.passed === false && failedAcceptance.checks[0].exitCode === 1 && executions().length === 1, '验收命令退出 1，保留失败回执和逐项实际输出。');
  stage('rejected', '错误补丁遭拒', 'rejected', '预置补丁遗漏 NFKC 与连续空白处理；公开验收在独立 Node 进程实际执行。', failedAcceptance);

  const stillFailed = await advance(cfg, request.id);
  check('no-silent-retry', '旧失败不会自动重跑', stillFailed.status === 'FAILED' && executions().length === 1 && digest(fs.readFileSync(failed.acceptance.path)) === digest(failedReceiptBytes), '再次推进仍为 FAILED；验收执行次数保持 1。');
  stage('blocked', '继续被失败门禁拦住', 'blocked', '普通继续不授权重试；失败证据保持原样。', {status: stillFailed.status, nextAction: stillFailed.nextAction.type, acceptanceRuns: executions().length});

  repairTask(cfg, request.id, 'normalize', {expectedAcceptanceHash: failed.acceptance.hash, reason: '一次显式修复：依据失败输出补齐 NFKC 和连续空白处理。'});
  await advance(cfg, request.id);
  const repairedPacket = getPacket(cfg, request.id, 'normalize');
  const archivedFailure = repairedPacket.repair.acceptancePath;
  const archivedResult = path.join(path.dirname(archivedFailure), 'result.json');
  check('explicit-repair', '显式修复创建新 attempt 并保留旧回执', repairedPacket.attemptId !== firstPacket.attemptId && digest(fs.readFileSync(archivedFailure)) === digest(failedReceiptBytes) && readJson(archivedResult).attemptId === firstPacket.attemptId, '同一 runId，仅一次 repairTask；历史失败与原提交回执都留在磁盘。');
  stage('repair', '一次有依据的修复', 'repaired', 'repairTask 绑定原失败哈希，归档旧证据，授予一个新 attempt。', {runId: request.id, previousAttemptId: firstPacket.attemptId, attemptId: repairedPacket.attemptId, archivedFailure, failureHash: digest(failedReceiptBytes)});

  fs.writeFileSync(artifact, after);
  const candidate = {id: 'label-normalization-verified', title: '标签规范化的验收经验', kind: 'solution', body: '标签规范化顺序为 NFKC、首尾空白清理、连续空白合并、小写和保序去重。公开用例验证通过，适用范围限本样例。'};
  submitResult(cfg, request.id, 'normalize', {expectedAttemptId: repairedPacket.attemptId, summary: '应用预置正确补丁；等待正式验收。', knowledgeCandidate: candidate});
  const passed = await advance(cfg, request.id);
  const passedAcceptance = readJson(passed.acceptance.path);
  const acceptedBytes = fs.readFileSync(passed.acceptance.path);
  check('repair-accepted', '修复后的补丁通过同一验收', passed.status === 'COMPLETE' && passedAcceptance.passed === true && executions().length === 2, '第二次真实验收退出 0，并记录产物哈希。');
  stage('accepted', '修复通过正式验收', 'passed', '同一公开检查脚本再次运行；经验回写绑定通过回执与实际产物。', passedAcceptance);

  const continued = await workbench(['continue', '--project', configFile, '--run', request.id]);
  check('continue-reused', '同 runId 接续复用验收', continued.reused === true && continued.delivery.runId === request.id && executions().length === 2 && fs.readFileSync(passed.acceptance.path).equals(acceptedBytes), '实际调用 continue；已完成的验收不重复执行。');
  stage('continue', '恢复交付，无重复验收', 'reused', 'continue 读取持久状态并复用完成回执。', {runId: continued.runId, reused: continued.reused, acceptanceRuns: executions().length, acceptanceHash: continued.acceptance.hash});

  const captured = search().items.some(item => item.id === candidate.id);
  fs.appendFileSync(artifact, '\n// Deliberate fixture tampering after acceptance.\n');
  let rejectedDelivery;
  try { delivery(cfg, request.id); } catch (error) { rejectedDelivery = error.message; }
  const staleExcluded = !search().items.some(item => item.id === candidate.id);
  check('delivery-drift-rejected', '产物变化立即阻止交付', Boolean(rejectedDelivery), rejectedDelivery ?? '错误：变化的产物未被拒绝。');
  check('stale-knowledge-excluded', '来源变化的经验停止参与检索', captured && staleExcluded, '验收后捕获的经验先可检索；来源产物改变后被排除。');
  stage('tamper', '篡改后拒绝交付', 'rejected', '验收通过不等于永久可信；产物哈希变化阻止 delivery，同时失效知识退出检索。', {message: rejectedDelivery, acceptedHash: passedAcceptance.artifacts['normalize-labels.mjs'], actualHash: digest(fs.readFileSync(artifact)), staleKnowledgeExcluded: staleExcluded});

  fs.writeFileSync(artifact, after);
  const delivered = delivery(cfg, request.id);
  check('restored-delivery', '恢复已验收字节后可以交付', delivered.status === 'COMPLETE' && delivered.acceptance.verified && search().items.some(item => item.id === candidate.id) && executions().length === 2, '恢复完全一致的产物；delivery 再次通过，仍为两次验收。');
  check('verifier-preserved', '公开验收脚本全程未改变', digest(fs.readFileSync(verifier)) === verifierHash, '独立检查文件位于任务写集之外；这是公开演示，不是安全沙箱。');
  stage('delivery', '交付可追溯证据', 'passed', '最终交付绑定当前产物、验收回执与已捕获知识，旧失败仍可查看。', delivered);

  const git = args => spawnSync('git', args, {cwd: repository, encoding: 'utf8', windowsHide: true});
  const revision = git(['rev-parse', 'HEAD']), dirty = git(['status', '--porcelain']);
  if (digest(sourceHashes()) !== digest(testedSource)) throw Error('Source files changed during the run; preserve this output and start a new run');
  const evidenceFiles = [artifact, verifier, path.join(acceptanceDirectory, 'executions.jsonl'), archivedFailure, archivedResult, path.join(path.dirname(archivedFailure), 'packet.json'), passed.acceptance.path, firstPacket.receiptPath, repairedPacket.receiptPath, delivered.knowledge.path, ...delivered.knowledge.captures.map(item => item.path)];
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    execution: {kind: 'deterministic-fixture', modelCalls: 0, acceptanceRuns: executions().length, fixtureIdentity: 'public-demo-only', notice: '确定性公开样例：补丁预先编写，调用真实工作流与 Node 验收；不是模型能力基准、隐藏测试或安全沙箱。'},
    source: {revision: revision.status === 0 ? revision.stdout.trim() : null, dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null, files: testedSource},
    runtime: {node: process.version, platform: process.platform},
    scenario: {id: request.id, title: '让错误补丁停在交付之前', objective: request.objective},
    summary: {passed: checks.filter(item => item.passed).length, total: checks.length}, checks, stages,
    patches: {before, after},
    knowledge: retrieved.map(({id, title, hash, source}) => ({id, title, hash, source})),
    artifacts: [...new Set(evidenceFiles)].map(file => ({path: file, sha256: digest(fs.readFileSync(file))})),
    evidence: {failedAcceptance, passedAcceptance, delivery: delivered},
    limitations: [
      '两份补丁由演示预置，模型调用为 0；检查通过率只描述本场景的交付门禁，不代表编码能力或生产收益。',
      '验收是独立 Node 子进程中的公开用例，未建立权限沙箱；同一操作系统用户仍可修改文件。',
      '仅覆盖单任务 direct 路由；未验证 Desktop 派工、多工作树并行、真实模型或人工验收。',
      '报告为可读的相对路径投影；原始回执与哈希保存在本次独立输出目录，fixture 身份不是真实用户。',
    ],
  };
  const sanitize = value => {
    if (typeof value === 'string') {
      if (value === outputRoot || value.startsWith(outputRoot + path.sep)) return (path.relative(outputRoot, value) || '.').split(path.sep).join('/');
      return value.replaceAll(outputRoot, '.').replaceAll(outputRoot.replaceAll('\\', '/'), '.').replaceAll(repository, '<repository>').replaceAll(process.execPath, 'node');
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  };
  writeJson(path.join(outputRoot, 'report.json'), sanitize(report));
  if (checks.some(item => !item.passed)) throw Error('Evidence Lab invariant failed; inspect report.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--fixture' && args.length === 2) await runFixture(args[1]);
    else {
      if (args.length && !(args.length === 2 && args[0] === '--output')) throw Error('Usage: node scripts/evidence-lab.mjs [--output <new-directory>]');
      const outputRoot = args[1] ? path.resolve(args[1]) : path.join(repository, '.local', 'evidence-lab', `${Date.now()}-${randomUUID().slice(0, 8)}`);
      console.log((await runEvidenceLab({outputRoot})).reportPath);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
