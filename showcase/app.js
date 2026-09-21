const byId = (id) => document.getElementById(id);
const labels = { passed: '已通过', rejected: '已拒绝', blocked: '已拦截', repaired: '已修复', reused: '已复用' };
let report;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function announce(message, error = false) {
  byId('action-status').textContent = message;
  byId('action-status').classList.toggle('error', error);
}

function validate(data) {
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const string = (value) => typeof value === 'string';
  const valid = object(data) && data.schemaVersion === 1
    && data.execution?.kind === 'deterministic-fixture' && data.execution.modelCalls === 0
    && string(data.execution.notice) && string(data.generatedAt)
    && object(data.scenario) && ['id', 'title', 'objective'].every((key) => string(data.scenario[key]))
    && object(data.source) && (data.source.revision === null || string(data.source.revision))
    && object(data.runtime) && string(data.runtime.node) && string(data.runtime.platform)
    && object(data.patches) && string(data.patches.before) && string(data.patches.after)
    && Array.isArray(data.checks) && data.checks.every((item) => object(item) && string(item.id) && string(item.title) && typeof item.passed === 'boolean' && string(item.detail))
    && Array.isArray(data.stages) && data.stages.length > 0 && data.stages.every((item) => object(item) && string(item.id) && string(item.title) && string(item.description) && Object.hasOwn(labels, item.status) && object(item.evidence))
    && object(data.summary) && data.summary.total === data.checks.length && data.summary.passed === data.checks.filter((item) => item.passed).length
    && Array.isArray(data.knowledge) && data.knowledge.every((item) => object(item) && string(item.id) && string(item.title))
    && Array.isArray(data.artifacts) && data.artifacts.every((item) => object(item) && string(item.path) && string(item.sha256))
    && Array.isArray(data.limitations) && data.limitations.every(string);
  if (!valid) throw new Error('报告格式不兼容。请载入 npm run demo 生成的 schemaVersion: 1 确定性演示报告。');
  return data;
}

function selectStage(index, focus = false) {
  const stage = report.stages[index];
  const buttons = byId('stage-list').querySelectorAll('button');
  buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  byId('stage-number').textContent = `EVIDENCE ${String(index + 1).padStart(2, '0')} / ${String(report.stages.length).padStart(2, '0')}`;
  byId('stage-status').textContent = labels[stage.status];
  byId('stage-status').className = `status-badge ${stage.status}`;
  byId('stage-title').textContent = stage.title;
  byId('stage-description').textContent = stage.description;
  byId('stage-json').textContent = JSON.stringify(stage.evidence, null, 2);
  if (focus) buttons[index].focus();
}

function render(data) {
  report = validate(data);
  byId('scenario-id').textContent = `SCENARIO / ${report.scenario.id}`;
  byId('case-title').textContent = report.scenario.title;
  byId('case-objective').textContent = report.scenario.objective;
  byId('check-score').textContent = `${report.summary.passed} / ${report.summary.total}`;
  byId('checks-count').textContent = `${report.summary.total} 项机制断言 · ${report.summary.total - report.summary.passed} 项未通过`;
  const date = new Date(report.generatedAt);
  const time = Number.isNaN(date.getTime()) ? report.generatedAt : date.toLocaleString('zh-CN', { hour12: false });
  const revision = report.source.revision === null ? '源码快照' : report.source.revision.slice(0, 10);
  const dirty = report.source.dirty === null ? ' · 改动状态未知' : report.source.dirty ? ' + 本地改动' : '';
  byId('report-meta').textContent = `${time} · ${revision}${dirty} · ${report.runtime.platform} / ${report.runtime.node}`;
  byId('report-meta').title = `来源版本：${report.source.revision ?? '源码快照（无 Git 提交号）'}`;

  const stages = byId('stage-list');
  stages.replaceChildren();
  report.stages.forEach((stage, index) => {
    const button = node('button', 'stage-button');
    button.type = 'button';
    button.setAttribute('aria-controls', 'stage-detail');
    button.setAttribute('aria-pressed', 'false');
    button.append(node('span', 'stage-index', String(index + 1).padStart(2, '0')));
    const copy = node('span', 'stage-copy');
    copy.append(node('span', 'stage-name', stage.title), node('span', `stage-outcome ${stage.status}`, labels[stage.status]));
    button.append(copy);
    button.addEventListener('click', () => selectStage(index));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? report.stages.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + report.stages.length) % report.stages.length;
      selectStage(next, true);
    });
    stages.append(button);
  });
  const rejectedIndex = report.stages.findIndex((stage) => stage.status === 'rejected');
  selectStage(rejectedIndex === -1 ? 0 : rejectedIndex);
  byId('patch-before').textContent = report.patches.before;
  byId('patch-after').textContent = report.patches.after;
  byId('checks-list').replaceChildren(...report.checks.map((check) => {
    const row = node('div', `check-row${check.passed ? '' : ' failed'}`);
    const icon = node('span', 'check-icon', check.passed ? '✓' : '×');
    icon.setAttribute('aria-label', check.passed ? '通过' : '未通过');
    const content = node('div', 'check-content');
    content.append(node('h3', 'check-title', check.title), node('p', 'check-detail', check.detail));
    row.append(icon, content, node('span', 'check-id', check.id));
    return row;
  }));
  byId('knowledge-list').replaceChildren(...report.knowledge.map((item) => {
    const entry = node('div', 'provenance-item');
    entry.append(node('p', 'provenance-title', item.title), node('p', 'provenance-meta', `ID: ${item.id}`));
    if (item.source) entry.append(node('p', 'provenance-meta', `来源：${typeof item.source === 'string' ? item.source : JSON.stringify(item.source)}`));
    if (item.hash) entry.append(node('p', 'hash-line', `HASH ${item.hash}`));
    return entry;
  }));
  if (!report.knowledge.length) byId('knowledge-list').append(node('p', 'empty-note', '本报告未包含项目知识条目。'));
  byId('artifact-list').replaceChildren(...report.artifacts.map((item) => {
    const entry = node('div', 'provenance-item');
    entry.append(node('p', 'provenance-title', item.path), node('p', 'hash-line', `SHA256 ${item.sha256}`));
    return entry;
  }));
  if (!report.artifacts.length) byId('artifact-list').append(node('p', 'empty-note', '本报告未包含交付产物。'));
  byId('execution-notice').textContent = report.execution.notice;
  byId('limitations-list').replaceChildren(...report.limitations.map((item) => node('li', '', item)));
  byId('raw-json').textContent = JSON.stringify(report, null, 2);
  byId('load-state').hidden = true;
  byId('report-content').hidden = false;
  byId('download-report').disabled = false;
}

byId('copy-command').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(byId('demo-command').textContent);
    announce('命令已复制。在仓库目录运行 npm run demo，即可重新生成演示报告。');
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(byId('demo-command'));
    selection.removeAllRanges();
    selection.addRange(range);
    announce('浏览器未开放剪贴板权限，已选中命令。请按 Ctrl+C 或 ⌘C 复制。');
  }
});

byId('patch-controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  const view = button.dataset.view;
  byId('before-pane').hidden = view === 'after';
  byId('after-pane').hidden = view === 'before';
  byId('patch-grid').classList.toggle('single', view !== 'both');
  byId('patch-controls').querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
});

byId('download-report').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = 'workbench-evidence-report.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce('已导出当前查看的完整 JSON 报告。');
});

byId('import-report').addEventListener('click', () => byId('report-file').click());
byId('report-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('报告超过 10 MB，请选择本地演示生成的 JSON 报告。');
    const data = JSON.parse(await file.text());
    render(data);
    byId('export-html').hidden = true;
    announce(`已载入 ${file.name}。页面显示该文件中的记录，未执行任何任务。`);
  } catch (error) {
    announce(error instanceof SyntaxError ? '无法解析此文件，请选择有效的 JSON 报告。' : error.message, true);
  } finally {
    event.target.value = '';
  }
});

document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item === link));
}));

async function loadReport() {
  byId('export-html').hidden = Boolean(window.WORKBENCH_REPORT) || location.protocol === 'file:';
  try {
    let data = window.WORKBENCH_REPORT;
    if (data == null) {
      if (location.protocol === 'file:') throw new Error('这个页面没有内嵌报告。请选择“载入报告”打开本地 report.json，或通过 npm run demo 启动后查看。');
      const response = await fetch('/report.json');
      if (!response.ok) throw new Error(`证据报告暂不可用（HTTP ${response.status}）。请运行 npm run demo 生成报告，或选择“载入报告”。`);
      data = await response.json();
    }
    render(data);
  } catch (error) {
    byId('load-state').classList.add('error');
    byId('load-state').querySelector('p').textContent = error instanceof SyntaxError ? '证据报告不是有效的 JSON。请重新生成，或载入一份本地报告。' : error instanceof TypeError ? '无法连接本地报告服务。请确认 npm run demo 正在运行，或选择“载入报告”查看已有 JSON 文件。' : error.message;
    byId('export-html').hidden = true;
  }
}

loadReport();
