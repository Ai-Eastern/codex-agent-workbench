// Public, deterministic checks: separate from the editable task file, not hidden or sandboxed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const cases = [
  {id: 'nfkc-and-deduplication', input: [' ＣＯＤＥＸ　ＡＧＥＮＴ ', 'codex agent', 'ＯＳＳ'], expected: ['codex agent', 'oss']},
  {id: 'chinese-whitespace', input: ['　缺陷\t修复 ', '缺陷 修复', '代码\n\t评审'], expected: ['缺陷 修复', '代码 评审']},
  {id: 'empty-and-stable-order', input: ['', '  ', 'Ｂ', 'a', 'b', 'Ａ'], expected: ['b', 'a']},
];
const {normalizeLabels} = await import(pathToFileURL(path.join(process.cwd(), 'normalize-labels.mjs')));
const results = cases.map(({id, input, expected}) => {
  try {
    const actual = normalizeLabels(input);
    assert.deepEqual(actual, expected);
    return {id, passed: true, actual, expected};
  } catch (error) {
    return {id, passed: false, actual: error.actual ?? null, expected, message: error.message};
  }
});
const ledger = new URL('./executions.jsonl', import.meta.url);
const invocation = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').length + 1 : 1;
const result = {invocation, passed: results.every(item => item.passed), cases: results};
fs.appendFileSync(ledger, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
