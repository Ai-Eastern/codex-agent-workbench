import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runEvidenceLab} from '../scripts/evidence-lab.mjs';
import {digest} from '../src/contracts.mjs';

test('Evidence Lab keeps real failed and passed receipts, rejects drift, and isolates fixture identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-evidence-lab-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'workbench-evidence-lab-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const originalIdentity = process.env.CODEX_THREAD_ID;
  const outputRoot = path.join(root, 'first');
  await assert.rejects(runEvidenceLab({outputRoot: root}), /already exists/);
  await assert.rejects(runEvidenceLab({outputRoot: 'relative-output'}), /absolute/);
  const {report, reportPath} = await runEvidenceLab({outputRoot});
  assert.equal(process.env.CODEX_THREAD_ID, originalIdentity);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.execution.kind, 'deterministic-fixture');
  assert.equal(report.execution.modelCalls, 0);
  assert.equal(report.execution.acceptanceRuns, 2);
  for (const [file, sha256] of Object.entries(report.source.files)) assert.equal(sha256, digest(fs.readFileSync(new URL(`../${file}`, import.meta.url))));
  assert.ok(report.source.files['src/workflow.mjs']);
  assert.ok(report.source.files['package-lock.json']);
  assert.equal(report.summary.passed, report.summary.total);
  assert.ok(report.summary.total >= 9);
  assert.equal(report.evidence.failedAcceptance.passed, false);
  assert.equal(report.evidence.failedAcceptance.checks[0].exitCode, 1);
  assert.equal(report.evidence.passedAcceptance.passed, true);
  assert.equal(report.evidence.passedAcceptance.checks[0].exitCode, 0);
  assert.equal(report.evidence.delivery.status, 'COMPLETE');
  assert.equal(digest(report.patches.before), report.evidence.failedAcceptance.artifacts['normalize-labels.mjs']);
  assert.equal(digest(report.patches.after), report.evidence.passedAcceptance.artifacts['normalize-labels.mjs']);
  assert.equal(report.stages.find(item => item.id === 'continue').evidence.reused, true);
  assert.equal(report.stages.find(item => item.id === 'tamper').evidence.staleKnowledgeExcluded, true);
  const ledger = fs.readFileSync(path.join(outputRoot, 'acceptance/executions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(ledger.map(item => item.passed), [false, true]);
  assert.deepEqual(ledger.map(item => item.invocation), [1, 2]);
  for (const item of report.artifacts) {
    assert.equal(path.isAbsolute(item.path), false);
    assert.equal(item.sha256, digest(fs.readFileSync(path.resolve(outputRoot, item.path))));
  }
  const failure = report.artifacts.find(item => item.path.includes('/history/') && item.path.endsWith('/acceptance.json'));
  assert.ok(failure);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.resolve(outputRoot, failure.path))), report.evidence.failedAcceptance);
  const passedFile = path.resolve(outputRoot, report.evidence.delivery.acceptance.path);
  assert.equal(digest(fs.readFileSync(passedFile)), report.evidence.delivery.acceptance.hash);
  assert.equal(digest(fs.readFileSync(path.join(outputRoot, 'work/normalize-labels.mjs'))), report.evidence.delivery.artifacts['normalize-labels.mjs']);
  const bytes = fs.readFileSync(reportPath);
  assert.equal(bytes.includes(Buffer.from(outputRoot)), false);
  assert.equal(bytes.includes(Buffer.from(outputRoot.replaceAll('\\', '/'))), false);
  assert.doesNotMatch(bytes.toString('utf8'), /"[A-Za-z]:[\\/]/);
  if (originalIdentity && originalIdentity !== '11111111-1111-4111-8111-111111111111') assert.equal(bytes.includes(Buffer.from(originalIdentity)), false);
  await assert.rejects(runEvidenceLab({outputRoot}), /already exists/);
  assert.deepEqual(fs.readFileSync(reportPath), bytes);
});
