import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../src/cli.mjs';

test('CLI help explains command order without requiring or opening a project', async () => {
  for (const args of [[], ['--help'], ['help'], ['-h']]) {
    const result = await main(args);
    assert.match(result.usage, /<command> --project/);
    assert.match(result.search, /search --project .* --query/);
    assert(result.commands.includes('repair-knowledge'));
  }
});
