import fs from 'node:fs';
import path from 'node:path';
import {runCheck} from './workflow.mjs';

// Internal stdin/JSON worker. The asynchronous parent owns the timeout and reaps this exact tree.
let payload;
const started = Date.now();
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw Error('INPUT_LIMIT');
    chunks.push(chunk);
  }
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const {check, cwd, context} = payload;
  let command = check.command, args = check.args;
  if (process.platform === 'win32') {
    if (/^(npm|npx)$/i.test(command)) {
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command.toLowerCase()}-cli.js`);
      if (!fs.existsSync(cli) || !fs.statSync(cli).isFile()) throw Error('NPM_CLI_NOT_FOUND: use node with an explicit npm-cli.js or npx-cli.js path');
      command = 'node'; args = [cli, ...args];
    } else if (/\.(cmd|bat|ps1)$/i.test(command)) throw Error('SHELL_SHIM_UNSUPPORTED: use an executable or node with an explicit script');
  }
  // Disarm spawnSync's direct-child timeout: only the parent can kill the whole acceptance tree.
  const result = runCheck({...check, command, args, timeoutMs: 0}, cwd, context);
  process.stdout.write(JSON.stringify({...result, command: check.command, args: check.args}) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({command: payload?.check?.command ?? '', args: payload?.check?.args ?? [], exitCode: null, stdout: '', stderr: '', error: error.message, elapsedMs: Date.now() - started}) + '\n');
}
// Retain the root until the parent has the complete receipt, including JSON-escaped command output.
setInterval(() => {}, 1000);
