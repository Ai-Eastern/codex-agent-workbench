import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtures = path.dirname(fileURLToPath(import.meta.url));
export function prepareProjects(destination) {
  const root = destination ? path.resolve(destination) : fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-three-projects-'));
  // Explicit destinations must be new: never overwrite an existing workspace.
  if (destination) fs.mkdirSync(root);
  const projects = ['project-a', 'project-b', 'project-c'].map(projectId => {
    const repository = path.join(root, projectId);
    fs.cpSync(path.join(fixtures, projectId), repository, { recursive: true, errorOnExist: true });
    fs.writeFileSync(path.join(repository, '.gitattributes'), '* text eol=lf\n');
    const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', `core.hooksPath=${path.join(repository, '.git', 'disabled-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Workbench Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--quiet');
    git('add', '--', '.');
    git('commit', '--quiet', '-m', 'Freeze deliberately defective fixture baseline');
    return { projectId, repository: projectId, baseCommit: git('rev-parse', 'HEAD') };
  });
  const setup = { schemaVersion: 1, kind: 'fixture-setup', hostAcceptance: 'incomplete', projects };
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify(setup, null, 2) + '\n');
  return { root, ...setup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareProjects(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
