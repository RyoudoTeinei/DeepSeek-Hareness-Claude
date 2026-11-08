import path from 'node:path';
import os from 'node:os';
import {existsSync, mkdirSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const defaultIgnores = [
 '.dsh-sync',
 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.pytest_cache',
 'dist', 'build', '.env', '.env.*', '*.pem', '*.key',
 'checkpoints', 'datasets', '*.safetensors', '*.ckpt', '*.pt', '*.pth', '*.gguf',
 '*.mp4', '*.mov', '*.mkv', '*.zip', '*.tar', '*.tar.gz', '*.7z',
];
export function syncOptions(input = {}) {
 const maxFileMiB = Number(input.maxFileMiB ?? 100);
 if (!Number.isInteger(maxFileMiB) || maxFileMiB < 1 || maxFileMiB > 102400)
  throw Error('单文件上限需为 1–102400 MiB 的整数');
 const ignores = input.ignores ?? defaultIgnores;
 if (!Array.isArray(ignores) || ignores.length > 500 ||
     ignores.some(p => typeof p !== 'string' || !p.trim() || p.length > 500 || /[\0\r\n,]/.test(p)))
  throw Error('忽略规则需为每行一个路径或通配符，不支持逗号');
 return {maxFileMiB, ignores: [...new Set(ignores.map(p => p.trim()))]};
}
export function describeSession(session) {
 const problems = [session?.lastError];
 for (const endpoint of [session?.alpha, session?.beta]) {
  for (const kind of ['scanProblems', 'transitionProblems'])
   for (const p of endpoint?.[kind] || []) problems.push((p.path ? p.path + ' · ' : '') + p.error);
 }
 return {
  enabled: !!session && !session.paused, paused: !!session?.paused,
  mode: session?.mode || 'two-way-safe', status: session?.status || '未开启',
  conflicts: (session?.conflicts?.length || 0) + (session?.excludedConflicts || 0),
  conflictPaths: (session?.conflicts || []).map(c => c.root || '项目根目录'),
  problems: problems.filter(Boolean), connected: !!session?.alpha?.connected && !!session?.beta?.connected,
  options: session?.mode === 'two-way-safe'
   ? {maxFileMiB: Number(session.maxStagingFileSize || 104857600) / 1048576,
      ignores: session.ignore?.paths || []}
   : syncOptions(),
 };
}
export function returnFiles(action, {host, project, identity, syncSettings}) {
 if (!/^[\w][\w.@-]*$/.test(host) || !/^\w[\w-]{0,47}$/.test(project))
  throw Error('工作区连接信息无效');
 const destination = path.resolve('.');
 const name = 'dsh-' + createHash('sha256').update(JSON.stringify([destination.toLowerCase(), host, project])).digest('hex').slice(0,24);
 const exe = fileURLToPath(new URL('./mutagen/mutagen.exe', import.meta.url));
 const program = process.platform==='win32' ? (existsSync(exe) ? exe : 'mutagen.exe') : 'mutagen';
 const dataDir = path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'), 'DSH-Remote-Claude', 'mutagen');
 const env = {...process.env, MUTAGEN_DATA_DIRECTORY: dataDir};
 function run(args) {
  const r = spawnSync(program, ['sync', ...args], {env, encoding:'utf8', windowsHide:true, timeout:90000, maxBuffer:4*1024*1024});
  if (r.error?.code === 'ENOENT') throw Error('请先安装 Mutagen 并将 mutagen.exe 加入 PATH，然后重启 DSH。');
  if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr.trim() || '同步服务调用失败');
  return r.stdout.trim();
 }
 function session() {
  const sessions = JSON.parse(run(['list', '--label-selector', 'workspace='+name, '--template', '{{json .}}']) || 'null') || [];
  if (sessions.length > 1) throw Error('检测到多个同步任务，请先在终端检查，避免并行同步。');
  return sessions[0];
 }
 if (action === 'watch-status') return describeSession(session());
 mkdirSync(dataDir, {recursive:true});
 const lockPath = path.join(dataDir, name+'.lock');
 let lock;
 try { lock = openSync(lockPath, 'wx'); }
 catch { throw Error('此工作区正在更改同步设置。若上次任务异常退出，请检查同步任务后移除锁文件：'+lockPath); }
 try {
  const previous = session();
  if (action === 'watch-off') {
   if (previous && !previous.paused) run(['pause', previous.identifier]);
   return describeSession(session());
  }
  if (!['watch-on', 'watch-apply'].includes(action)) throw Error('未知同步操作');
  if (identity) throw Error('后台同步使用系统 OpenSSH。请把专用私钥配置到 SSH 别名，并在工作区中使用该别名。');
  if (action === 'watch-on' && previous?.mode === 'two-way-safe') {
   if(!(previous.ignore?.paths||[]).includes('.dsh-sync'))
    throw Error('请先应用一次同步设置，将 .dsh-sync 加入旧引擎的忽略规则');
   if (previous.paused) run(['resume', previous.identifier]);
   return describeSession(session());
  }
  const settings = syncOptions(syncSettings);
  const next = name+'-'+randomUUID().slice(0,8);
  // Validate the replacement while paused before touching the current session.
  run(['create', '--paused', '--no-global-configuration', '--name', next,
   '--label', 'workspace='+name, '--mode', 'two-way-safe', '--ignore-vcs',
   '--max-staging-file-size', String(settings.maxFileMiB*1048576),
   '--symlink-mode', 'ignore', '--ignore', '.dsh-sync', ...settings.ignores.filter(p=>p!=='.dsh-sync').flatMap(p => ['--ignore', p]),
   host+':projects/'+project, destination]);
  try {
   if (previous && !previous.paused) run(['pause', previous.identifier]);
   if (action === 'watch-on' || (previous && !previous.paused)) run(['resume', next]);
   if (previous) run(['terminate', previous.identifier]);
  } catch (error) {
   // Terminating a session removes bookkeeping only, never endpoint files.
   run(['terminate', next]);
   if (previous && !previous.paused) run(['resume', previous.identifier]);
   throw error;
  }
  return describeSession(session());
 } finally { closeSync(lock); unlinkSync(lockPath); }
}
