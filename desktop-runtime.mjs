import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {mkdir, open, readFile, link, unlink, lstat} from 'node:fs/promises';
import path from 'node:path';
import {storedRoute} from './session-binding.mjs';
import {atomicJson, readJson, desktopDirectory, desktopScope, listDesktopRequests,
  recordDesktopRequest, remoteDesktopResult, validateDesktopRequest, MAX_ARTIFACT_BYTES} from './desktop-state.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const PREFIX = 'DSH_DESKTOP:';
export const sshArguments = cfg => ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
  '-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4',
  '-o','SendEnv=-*', ...(cfg.identity ? ['-o','IdentitiesOnly=yes','-i',cfg.identity] : [])];

function ssh(cfg, command, input, interactive = false) {
  const child = spawn('ssh', [...sshArguments(cfg), ...(interactive ? ['-tt'] : ['-T']), cfg.host, command], {
    stdio:interactive ? 'inherit' : ['pipe','pipe','pipe'], windowsHide:true,
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('SSH 操作未完成')));
  });
  done.catch(() => {});
  if (!interactive) {
    child.stderr.resume();
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
  }
  return {child, done};
}

export async function receiveArtifact(lines, destination) {
  const temporary = destination + '.partial';
  const file = await open(temporary, 'wx', 0o600);
  let header, end, count = 0;
  const hash = createHash('sha256');
  try {
    for await (const line of lines) {
      if (!line.startsWith(PREFIX)) continue;
      if (line.length > 100_000) throw Error('文件传输帧过大');
      const event = JSON.parse(line.slice(PREFIX.length));
      if (end) throw Error('文件传输已结束');
      if (event.type === 'file') {
        if (header || !Number.isSafeInteger(event.size) || event.size < 0 || event.size > MAX_ARTIFACT_BYTES) throw Error('文件大小无效');
        header = event;
      } else if (event.type === 'data') {
        if (!header || typeof event.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.base64)) throw Error('文件传输帧无效');
        const data = Buffer.from(event.base64, 'base64');
        count += data.length;
        if (count > header.size || count > MAX_ARTIFACT_BYTES) throw Error('文件超过大小限制');
        hash.update(data);
        await file.writeFile(data);
      } else if (event.type === 'end') end = event;
      else throw Error('未知文件传输帧');
    }
    if (!header || !end || count !== header.size || end.size !== count || end.sha256 !== hash.digest('hex')) throw Error('文件校验失败');
    await file.sync();
    await file.close();
    // Each request has its own directory. Never overwrite an earlier download.
    await link(temporary, destination);
    await unlink(temporary);
    return destination;
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function openDesktopFile(file) {
  if (process.platform !== 'win32') throw Error('当前版本的本机打开功能需要 Windows');
  const script = "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:DSH_DESKTOP_ARTIFACT";
  const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {
    env:{...process.env, DSH_DESKTOP_ARTIFACT:file}, windowsHide:true, stdio:'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('本机应用未能打开文件')));
  });
}

async function downloadArtifact(cfg, scope, request, directory) {
  const received = path.join(directory, 'received');
  await mkdir(received, {recursive:true});
  if ((await lstat(received)).isSymbolicLink()) throw Error('接收目录不能是链接');
  const folder = path.join(received, request.id);
  await mkdir(folder); // Exclusive request destination, including after an ambiguous failure.
  const destination = path.join(folder, path.posix.basename(request.path));
  const remote = '"$HOME/.local/state/dsh-remote/desktop/' + scope + '/desktop-remote.py"';
  const {child, done} = ssh(cfg, 'python3 ' + remote + ' artifact', JSON.stringify({path:request.path}));
  const timer = setTimeout(() => child.kill(), 300_000);
  const lines = createInterface({input:child.stdout});
  try {
    const file = await receiveArtifact(lines, destination);
    await done;
    return file;
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null) child.kill();
  }
}

export async function executeDecision(directory, record, decision, actions) {
  const request = validateDesktopRequest(record.request);
  const file = path.join(directory,'requests',request.id + '.json');
  if (!decision.approved) {
    const denied = {...record, status:'denied'};
    await atomicJson(file, denied);
    return remoteDesktopResult(request.id, 'denied');
  }
  // Write before the side effect. A crash here becomes a failed request on
  // reconnect, never an automatic repeat of opening an application.
  await atomicJson(file, {...record, status:'running'});
  let localFile;
  let code = 'TRANSFER_FAILED';
  try {
    localFile = await actions.download(request);
    if (request.action === 'open_file') {
      code = 'OPEN_FAILED';
      await actions.open(localFile);
    }
    await atomicJson(file, {...record, status:'completed', localFile});
    return remoteDesktopResult(request.id, 'completed');
  } catch {
    await atomicJson(file, {...record, status:'failed', code, ...(localFile ? {localFile} : {})});
    return remoteDesktopResult(request.id, 'failed', code);
  }
}

async function installRemote(cfg, scope) {
  const source = await readFile(new URL('./desktop-remote.py', import.meta.url),'utf8');
  const bootstrap = `import json,sys,os,pathlib,subprocess,uuid
os.umask(0o077)
p=json.load(sys.stdin)
root=pathlib.Path.home()/'.local/state/dsh-remote/desktop'/p['scope']
root.mkdir(parents=True,exist_ok=True)
for name,contents in [('desktop-remote.py',p['source']),('config.json',json.dumps({'project':p['project']}))]:
 temp=root/(name+'.'+uuid.uuid4().hex+'.tmp');temp.write_text(contents);temp.replace(root/name)
for name in ('requests','responses'):(root/name).mkdir(exist_ok=True)
mcp={'mcpServers':{'dsh-desktop':{'command':'python3','args':[str(root/'desktop-remote.py')]}}}
temp=root/'mcp.json.tmp';temp.write_text(json.dumps(mcp));temp.replace(root/'mcp.json')
project=pathlib.Path.home()/'projects'/p['project'];project.mkdir(parents=True,exist_ok=True)
session='dsh-'+p['scope']+'-claude'
if subprocess.run(['tmux','has-session','-t','='+session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
 import shlex
 sid=str(uuid.UUID(p['scope']))
 resumed=any((pathlib.Path.home()/'.claude/projects').glob('*/'+sid+'.jsonl'))
 args=['claude','--resume' if resumed else '--session-id',sid,'--mcp-config',str(root/'mcp.json')]
 command='export PATH="$HOME/.local/bin:$PATH"; exec '+shlex.join(args)
 subprocess.run(['tmux','new-session','-d','-s',session,'-c',str(project),command],check=True)
subprocess.run(['tmux','set-option','-t',session,'mouse','on'],check=True)
print('DSH_DESKTOP_READY')`;
  const command = 'python3 -c ' + quote(bootstrap);
  const {child, done} = ssh(cfg, command, JSON.stringify({scope,project:cfg.project,source}));
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-2048); });
  const timer = setTimeout(() => child.kill(), 30_000);
  try { await done; if (!output.includes('DSH_DESKTOP_READY')) throw Error('桌面工具安装未完成'); }
  finally { clearTimeout(timer); }
}

export async function connectDesktop(cfg, sessionId) {
  const scope = desktopScope(sessionId,cfg.host,cfg.project);
  const directory = desktopDirectory(scope);
  await mkdir(directory,{recursive:true});
  const lockFile = path.join(directory,'connection.lock');
  let lock;
  try { lock = await open(lockFile,'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(await readFile(lockFile,'utf8'));
    if (!Number.isSafeInteger(owner) || owner < 1) throw Error('桌面连接锁异常，请检查连接状态');
    let alive = true;
    try { process.kill(owner,0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
    if (alive) throw Error('此聊天的桌面连接已打开。请先关闭旧终端标签再接入。');
    // A second exclusive lock serializes stale-lock recovery. Re-read the
    // owner inside it so two reconnects cannot replace each other's live lock.
    const recoveryFile = lockFile+'.recovery';
    const recovery = await open(recoveryFile,'wx');
    try {
      if (Number(await readFile(lockFile,'utf8')) !== owner) throw Error('连接状态正在变化，请重试');
      await unlink(lockFile);
      lock = await open(lockFile,'wx');
      await lock.writeFile(String(process.pid));
    } finally {
      await recovery.close();
      await unlink(recoveryFile).catch(() => {});
    }
  }
  await lock.truncate(0);
  await lock.write(String(process.pid),0,'utf8');
  let terminal, relayChild, stopped = false, timer;
  const stop = () => { stopped = true; terminal?.child.kill(); relayChild?.kill(); };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  process.once('SIGHUP',stop);
  try {
    const routeFile = path.join(process.env.LOCALAPPDATA,'DSH-Remote-Claude','chat-routes',createHash('sha256').update(sessionId).digest('hex') + '.json');
    const bound = await storedRoute(sessionId);
    if (!bound || !bound.desktopTools || bound.host !== cfg.host || bound.project !== cfg.project || path.resolve(bound.localRoot).toLowerCase() !== path.resolve('.').toLowerCase()) throw Error('工作区绑定已改变，请重新接入');
    await installRemote(cfg,scope);
    if (stopped) throw Error('桌面连接已取消');
    const remote = '"$HOME/.local/state/dsh-remote/desktop/'+scope+'/desktop-remote.py"';
    const relay = ssh(cfg,'python3 '+remote+' relay');
    relayChild = relay.child;
    let serial = Promise.resolve();
    const reader = createInterface({input:relayChild.stdout});
    let markReady;
    const ready = new Promise(resolve => {markReady=resolve});
    reader.on('line',line => {
      if (!line.startsWith(PREFIX)) return;
      serial = serial.then(async () => {
        if (line.length > 16_384) return;
        const event = JSON.parse(line.slice(PREFIX.length));
        if (event.type === 'ready') markReady();
        if (event.type === 'request') await recordDesktopRequest(directory,event.request);
      }).catch(() => { console.error('收到无效的桌面请求，请在工作台检查状态。'); });
    });
    const readyTimer = setTimeout(() => relayChild.kill(),15_000);
    try { await Promise.race([ready,relay.done.then(()=>{throw Error('桌面请求通道未就绪')})]); }
    finally { clearTimeout(readyTimer); }
    await atomicJson(routeFile,{...bound, desktopScope:scope, activeTmuxSession:'dsh-'+scope+'-claude'});
    await atomicJson(path.join(directory,'connection.json'),{state:'connected',pid:process.pid});
    const delivered = new Set();
    async function processQueue() {
      for (const record of await listDesktopRequests(directory)) {
        const id = record.request.id;
        if (delivered.has(id)) continue;
        let response;
        if (record.status === 'pending') {
          const decision = await readJson(path.join(directory,'decisions',id+'.json'));
          if (!decision) continue;
          response = await executeDecision(directory,record,decision,{
            download:request => downloadArtifact(cfg,scope,request,directory),open:openDesktopFile,
          });
        } else if (record.status === 'running') {
          await atomicJson(path.join(directory,'requests',id+'.json'),{...record,status:'failed',code:'LOCAL_UNAVAILABLE'});
          response = remoteDesktopResult(id,'failed','LOCAL_UNAVAILABLE');
        } else response = remoteDesktopResult(id,record.status,record.code);
        if (relayChild.stdin.destroyed) return;
        relayChild.stdin.write(JSON.stringify(response)+'\n');
        delivered.add(id);
      }
    }
    timer = setInterval(() => {
      serial = serial.then(() => stopped ? undefined : processQueue()).catch(() => {});
    },700);
    terminal = ssh(cfg,'tmux attach -d -t =dsh-'+scope+'-claude',undefined,true);
    try {
      await Promise.race([terminal.done,relay.done.then(() => {throw Error('桌面请求通道已断开，请重新接入');})]);
    } finally {
      stopped = true;
      clearInterval(timer);
      await serial;
      reader.close();
    }
  } finally {
    stopped = true;
    clearInterval(timer);
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
    process.removeListener('SIGHUP',stop);
    terminal?.child.kill();
    relayChild?.kill();
    await atomicJson(path.join(directory,'connection.json'),{state:'disconnected'});
    await lock.close();
    await unlink(lockFile).catch(() => {});
  }
}
