const get = (id) => document.getElementById(id);
const phaseLabels = {
  PREPARING: '准备工作区', PREPARED: '等待编码', EXECUTING: '编码中', EXECUTED: '编码结束',
  ACCEPTING: '独立验收中', FAILED_ACCEPTANCE: '验收未通过', BLOCKED: '需要处理',
  READY_FOR_REVIEW: '待人工评审', EVIDENCE_CHANGED: '证据已变化', INTERRUPTED: '已中断',
  CANCELLED: '已停止', FAILED_EXECUTION: '执行失败', EXECUTION_FAILED: '执行失败', FAILED: '执行失败',
};
const activePhases = new Set(['PREPARING', 'PREPARED', 'EXECUTING', 'EXECUTED', 'ACCEPTING']);
let token, selectedId = null, selectedRun = null, currentDiff = null, busy = false, timer, refreshing = false;
let runs = [], eventsSignature = '', runSignature = '', listSignature = '', selectionRequest = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function phaseClass(phase) {
  return phase === 'READY_FOR_REVIEW' ? 'ready' : activePhases.has(phase) ? 'running' : 'failed';
}

function connected(ok) {
  get('connection-status').textContent = ok ? '本地服务已连接' : '连接异常';
  get('connection-dot').className = `connection-dot ${ok ? 'connected' : 'error'}`;
}

function showError(error) {
  get('error-message').textContent = error instanceof Error ? error.message : String(error);
  get('error-banner').hidden = false;
}

function announce(message) { get('action-message').textContent = message; }
function dateText(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

async function api(url, { body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    if (!token) throw new Error('本地服务尚未就绪，无法发起任务。请点击侧栏刷新。');
    headers['Content-Type'] = 'application/json';
    headers['X-Workbench-Token'] = token;
  }
  let response;
  try { response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch { throw new Error('无法连接本地服务。请确认工作台服务正在运行，再点击侧栏刷新。'); }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`HTTP ${response.status}：服务返回了无法解析的 JSON。`); }
  if (!response.ok) {
    const message = data?.error?.message ?? data?.message ?? (typeof data?.error === 'string' ? data.error : '请求未能完成');
    throw new Error(`HTTP ${response.status}：${message}`);
  }
  return data;
}

function setBusy(value) {
  busy = value;
  get('start-task').disabled = value || !token;
  get('cancel-run').disabled = value;
  get('repair-run').disabled = value;
}

function renderRuns() {
  const signature = JSON.stringify([selectedId, runs]);
  if (signature === listSignature) return;
  listSignature = signature;
  const focusedId = get('run-list').contains(document.activeElement) ? document.activeElement.dataset.runId : null;
  get('run-count').textContent = String(runs.length);
  get('run-list').replaceChildren(...runs.map((run) => {
    const button = node('button', 'run-item');
    button.type = 'button';
    button.dataset.runId = run.id;
    button.setAttribute('aria-pressed', String(run.id === selectedId));
    const title = run.request?.objective || run.id;
    button.append(node('span', 'run-item-title', title));
    button.title = title;
    const meta = node('span', 'run-item-meta');
    meta.append(node('span', `run-item-state ${phaseClass(run.phase)}`, phaseLabels[run.phase] ?? run.phase), node('span', 'run-item-date', dateText(run.createdAt)));
    button.append(meta);
    button.addEventListener('click', () => selectRun(run.id));
    return button;
  }));
  if (!runs.length) get('run-list').append(node('p', 'sidebar-empty', '还没有编码任务。填写右侧目标，开始第一次运行。'));
  if (focusedId) [...get('run-list').querySelectorAll('button')].find((button) => button.dataset.runId === focusedId)?.focus();
}

function newTask() {
  selectedId = null;
  selectedRun = null;
  currentDiff = null;
  get('create-view').hidden = false;
  get('run-view').hidden = true;
  get('page-label').textContent = '新建任务';
  announce('');
  renderRuns();
  get('objective').focus();
}

async function selectRun(id) {
  selectedId = id;
  selectedRun = null;
  currentDiff = null;
  eventsSignature = '';
  runSignature = '';
  get('create-view').hidden = true;
  get('run-view').hidden = false;
  get('page-label').textContent = '任务详情';
  get('run-title').textContent = '正在读取任务…';
  get('run-id').textContent = id;
  get('run-created').textContent = '';
  get('run-phase').textContent = '读取中';
  get('run-phase').className = 'phase-badge';
  get('run-file-count').textContent = '—';
  get('run-budget').textContent = '—';
  get('workspace-path').textContent = '正在读取工作区';
  get('run-summary').textContent = '正在读取记录…';
  get('usage-summary').textContent = '';
  get('cancel-run').hidden = true;
  get('repair-panel').hidden = true;
  get('review-panel').hidden = true;
  get('diff-panel').hidden = true;
  get('repair-reason').value = '';
  get('acceptance-content').replaceChildren();
  get('event-list').replaceChildren();
  get('raw-run').textContent = '';
  get('raw-events').textContent = '';
  get('event-count').textContent = '';
  announce('');
  renderRuns();
  try { await loadSelected(id); }
  catch (error) { if (selectedId === id) showError(error); }
}

function renderRun(run) {
  selectedRun = run;
  const signature = JSON.stringify(run);
  if (signature === runSignature) return;
  runSignature = signature;
  get('run-id').textContent = `TASK / ${run.id}`;
  get('run-title').textContent = run.request?.objective || run.id;
  get('run-created').textContent = `创建于 ${dateText(run.createdAt) || '未记录'}`;
  get('run-phase').textContent = phaseLabels[run.phase] ?? run.phase;
  get('run-phase').className = `phase-badge ${phaseClass(run.phase)}`;
  get('run-file-count').textContent = Array.isArray(run.request?.files) ? `${run.request.files.length} 个文件` : '未记录';
  get('run-budget').textContent = Number.isFinite(run.request?.timeoutMs) ? `${run.request.timeoutMs / 60000} 分钟` : '沿用默认';
  get('workspace-path').textContent = run.workspace?.directory || '尚未生成工作区';
  get('cancel-run').hidden = !activePhases.has(run.phase);
  get('repair-panel').hidden = run.phase !== 'FAILED_ACCEPTANCE';
  get('review-panel').hidden = run.phase !== 'READY_FOR_REVIEW';
  if (run.phase !== 'READY_FOR_REVIEW') { currentDiff = null; get('diff-panel').hidden = true; }
  const error = run.evidenceError || run.error || run.acceptanceError || run.execution?.reason;
  get('run-summary').textContent = [error ? `需要处理：${error}` : '', run.execution?.summary || (!error ? '尚无 Agent 交付说明。完成编码后会显示实际返回的总结。' : '')].filter(Boolean).join('\n\n');
  const usage = run.execution?.usage;
  get('usage-summary').textContent = usage && typeof usage === 'object' ? [
    Number.isFinite(usage.input_tokens) ? `输入 ${usage.input_tokens}` : null,
    Number.isFinite(usage.cached_input_tokens) ? `其中缓存 ${usage.cached_input_tokens}` : null,
    Number.isFinite(usage.output_tokens) ? `输出 ${usage.output_tokens}` : null,
  ].filter(Boolean).join(' · ') : '';
  const checks = run.acceptanceDetails?.checks;
  get('acceptance-content').replaceChildren(...(Array.isArray(checks) ? checks.map(check => {
    const row = node('div', 'check-entry');
    const header = node('div', 'check-heading');
    header.append(node('strong', '', check.id), node('span', check.exitCode === 0 ? 'check-pass' : 'check-fail', check.exitCode === 0 ? '通过' : check.exitCode === null ? '未完成' : `失败 · 退出码 ${check.exitCode}`));
    row.append(header, node('code', 'check-command', JSON.stringify([check.command, ...(check.args || [])])));
    const output = [check.error, check.stdout, check.stderr].filter(Boolean).join('\n');
    if (output) row.append(node('pre', 'check-output', output));
    return row;
  }) : [run.acceptance ? node('pre', '', JSON.stringify(run.acceptance, null, 2)) : node('p', 'empty-output', '尚无独立验收结果。执行完成后，工作台会运行预先约定的验收命令。')]));
  get('raw-run').textContent = JSON.stringify(run, null, 2);
}

function describeEvent(event) {
  const item = event.item;
  if (item?.type === 'command_execution') return { title: event.type === 'item.started' ? '执行命令' : '命令记录', description: `${item.command ?? ''}${item.exit_code == null ? '' : `\n退出码：${item.exit_code}`}${item.aggregated_output ? `\n${item.aggregated_output}` : ''}` };
  if (item?.type === 'agent_message') return { title: 'Agent 消息', description: item.text ?? '' };
  if (item?.type === 'file_change') return { title: '文件改动', description: Array.isArray(item.changes) ? item.changes.map((change) => `${change.kind ?? ''} ${change.path ?? ''}`).join('\n') : JSON.stringify(item) };
  if (event.type === 'thread.started') return { title: 'Codex 会话已建立', description: event.thread_id ?? '' };
  if (event.type === 'turn.started') return { title: '开始编码执行', description: '' };
  if (event.type === 'turn.completed') return { title: '编码执行结束', description: '这是执行结果，独立验收另行记录。' };
  if (event.type === 'turn.failed' || event.type === 'error') return { title: '执行错误', description: event.error?.message ?? event.message ?? JSON.stringify(event) };
  return { title: event.type || '事件', description: typeof event.message === 'string' ? event.message : JSON.stringify(event) };
}

function renderEvents(events) {
  const signature = JSON.stringify(events);
  if (signature === eventsSignature) return;
  eventsSignature = signature;
  const visible = events.slice(-120);
  get('event-count').textContent = `最近 ${visible.length} 条实际事件`;
  get('event-list').replaceChildren(...visible.map((event, index) => {
    const description = describeEvent(event);
    const row = node('div', `event-entry${['turn.failed', 'error'].includes(event.type) ? ' error' : ''}`);
    row.append(node('span', 'event-index', String(events.length - visible.length + index + 1).padStart(3, '0')));
    const body = node('div', 'event-body');
    const top = node('div', 'event-topline');
    top.append(node('span', 'event-title', description.title));
    if (event.at || event.timestamp) top.append(node('span', 'event-time', dateText(event.at || event.timestamp)));
    body.append(top);
    if (description.description) {
      const text = String(description.description);
      body.append(node('p', 'event-description', text.length > 900 ? `${text.slice(0, 900)}\n… 完整内容见原始事件` : text));
    }
    row.append(body);
    return row;
  }));
  if (!events.length) get('event-list').append(node('p', 'empty-output', '尚无执行事件。任务产生记录后会显示在这里。'));
  get('raw-events').textContent = JSON.stringify(events, null, 2);
}

async function loadSelected(id) {
  const request = ++selectionRequest;
  const prefix = `/api/runs/${encodeURIComponent(id)}`;
  const [run, eventData] = await Promise.all([api(prefix), api(`${prefix}/events`)]);
  if (selectedId !== id || request !== selectionRequest) return;
  renderRun(run);
  if (!Array.isArray(eventData.events)) throw new Error('HTTP 200：执行事件格式不正确。');
  renderEvents(eventData.events);
}

async function refresh({ project = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (project || !token) {
      const data = await api('/api/project');
      if (typeof data.token !== 'string' || !data.token) throw new Error('HTTP 200：本地服务未提供任务授权令牌。');
      token = data.token;
      get('project-name').textContent = data.projectName || '当前项目';
      get('project-path').textContent = data.repository || '';
      setBusy(busy);
    }
    const data = await api('/api/runs');
    if (!Array.isArray(data.runs)) throw new Error('HTTP 200：任务列表格式不正确。');
    runs = data.runs;
    renderRuns();
    if (selectedId) await loadSelected(selectedId);
    connected(true);
  } catch (error) { connected(false); showError(error); }
  finally { refreshing = false; }
}

function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(async () => { await refresh(); schedule(); }, 2000);
}

function lines(value) { return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]; }
function taskRequest() {
  const objective = get('objective').value.trim();
  const files = lines(get('files').value);
  const acceptanceFiles = lines(get('acceptance-files').value);
  if (!objective || !files.length) throw new Error('请填写任务目标和至少一个允许改动的文件。');
  const conflict = acceptanceFiles.find((file) => files.includes(file));
  if (conflict) throw new Error(`验收文件不能同时允许修改：${conflict}`);
  let argv;
  try { argv = JSON.parse(get('check-command').value); }
  catch { throw new Error('验收命令格式不正确，请填写 JSON 数组，例如 ["node", "--test"]。'); }
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !argv[0].trim()) throw new Error('验收命令必须是非空字符串组成的 JSON 数组。');
  const minutes = Number(get('timeout').value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('执行预算须为 1 至 60 分钟的整数。');
  const model = get('model').value.trim();
  return { objective, files, acceptanceFiles, knowledgeFiles: lines(get('knowledge-files').value), checks: [{ id: 'tests', command: argv[0], args: argv.slice(1) }], timeoutMs: minutes * 60000, ...(model ? { model } : {}) };
}

get('task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  try {
    const body = taskRequest();
    setBusy(true);
    const data = await api('/api/runs', { body });
    if (typeof data.id !== 'string' || !data.id) throw new Error('HTTP 202：服务未返回任务 ID。请刷新列表核对，避免重复提交。');
    await selectRun(data.id);
    announce('任务已提交。状态与执行记录会自动更新。');
    await refresh();
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});

get('cancel-run').addEventListener('click', async () => {
  if (busy || !selectedId || !activePhases.has(selectedRun?.phase)) return;
  const id = selectedId;
  setBusy(true);
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { body: {} });
    announce('停止请求已发送，最终状态以执行记录为准。');
    await refresh();
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});

get('repair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !selectedId || selectedRun?.phase !== 'FAILED_ACCEPTANCE') return;
  const reason = get('repair-reason').value.trim();
  if (!reason) { showError('请填写具体修复原因。'); return; }
  const id = selectedId;
  setBusy(true);
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/repair`, { body: { reason } });
    announce('已提交本轮修复原因。后续状态与验收结果会自动更新。');
    await refresh();
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});

async function fetchDiff() {
  if (!selectedId || selectedRun?.phase !== 'READY_FOR_REVIEW') throw new Error('只有进入待人工评审状态的任务才能查看交付 diff。');
  const id = selectedId;
  const data = await api(`/api/runs/${encodeURIComponent(id)}/diff`);
  if (id !== selectedId || selectedRun?.phase !== 'READY_FOR_REVIEW') return null;
  if (typeof data.diff !== 'string') throw new Error('HTTP 200：服务返回的 diff 格式不正确。');
  currentDiff = { id, text: data.diff };
  return currentDiff;
}

get('show-diff').addEventListener('click', async () => {
  try {
    const diff = await fetchDiff();
    if (!diff) return;
    get('diff-content').textContent = diff.text || '本次运行没有文件差异。';
    get('diff-panel').hidden = false;
    get('diff-content').focus();
  } catch (error) { showError(error); }
});

get('download-diff').addEventListener('click', async () => {
  try {
    const diff = await fetchDiff();
    if (!diff) return;
    const url = URL.createObjectURL(new Blob([diff.text], { type: 'text/x-diff;charset=utf-8' }));
    const link = node('a');
    link.href = url;
    link.download = `workbench-${diff.id.replace(/[^a-z0-9_-]/gi, '_')}.patch`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('diff 已下载。工作台未执行合并。');
  } catch (error) { showError(error); }
});

get('hide-diff').addEventListener('click', () => { get('diff-panel').hidden = true; get('show-diff').focus(); });
get('new-task').addEventListener('click', newTask);
get('refresh').addEventListener('click', async () => { await refresh({ project: true }); schedule(); });
get('dismiss-error').addEventListener('click', () => { get('error-banner').hidden = true; });
document.addEventListener('visibilitychange', async () => {
  clearTimeout(timer);
  if (!document.hidden) { await refresh(); schedule(); }
});
window.addEventListener('pagehide', () => clearTimeout(timer));
await refresh({ project: true });
schedule();
