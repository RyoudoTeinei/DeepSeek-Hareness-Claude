import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of readdirSync(root).filter(file => /\.(?:mjs|js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const test of ['tests/sync-settings.mjs', 'tests/local-tools.mjs', 'tests/chat-session.mjs']) {
  const result = spawnSync(process.execPath, [test], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const candidates = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : [['python3', []], ['python', []]];
for (const [program, prefix] of candidates) {
  const probe = spawnSync(program, [...prefix, '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], {
    stdio: 'ignore', windowsHide: true,
  });
  if (probe.error || probe.status !== 0) continue;
  const result = spawnSync(program, [...prefix, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
console.error('Tests require Python 3.8 or newer and Git on PATH.');
process.exit(1);
