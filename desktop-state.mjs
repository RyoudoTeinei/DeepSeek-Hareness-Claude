import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, readdir} from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_ACTIONS = new Set(['download', 'open_file']);
export const REQUEST_TTL = 15 * 60_000;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const OPEN_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.csv']);

export function desktopScope(sessionId, host, project) {
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,180}$/.test(sessionId)) throw Error('会话标识无效');
  if (!/^[\w][\w.@-]*$/.test(host) || !/^\w[\w-]{0,47}$/.test(project)) throw Error('工作区配置无效');
  return createHash('sha256').update(JSON.stringify([sessionId, host, project])).digest('hex').slice(0,32);
}

export function desktopDirectory(scope, base = process.env.LOCALAPPDATA) {
  if (!ID.test(scope) || !base) throw Error('本机工具目录不可用');
  return path.join(base, 'DSH-Remote-Claude', 'desktop', scope);
}

export function relativeArtifact(value) {
  if (typeof value !== 'string' || !value || value.length > 400 || /[\\:\x00-\x1f\x7f]/.test(value)) throw Error('需要项目相对路径');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw Error('项目相对路径无效');
  return value;
}

export function validateDesktopRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id','action','path','reason'].includes(key))) throw Error('本机操作格式无效');
  if (!ID.test(value.id) || !DESKTOP_ACTIONS.has(value.action)) throw Error('本机操作类型无效');
  const relative = relativeArtifact(value.path);
  if (typeof value.reason !== 'string' || value.reason.length > 400 || /[\x00-\x1f\x7f]/.test(value.reason)) throw Error('操作说明无效');
  if (value.action === 'open_file' && !OPEN_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) throw Error('此文件类型仅支持下载');
  return {id:value.id, action:value.action, path:relative, reason:value.reason};
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), {mode:0o600, flag:'wx'});
  await rename(temporary, file);
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function recordDesktopRequest(directory, input) {
  const request = validateDesktopRequest(input);
  const file = path.join(directory, 'requests', request.id + '.json');
  const previous = await readJson(file);
  if (previous) {
    if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw Error('请求标识已被占用');
    return previous;
  }
  const items = await listDesktopRequests(directory);
  if (items.filter(item => item.status === 'pending').length >= 32) throw Error('待确认请求过多');
  const record = {request, status:'pending', createdAt:Date.now()};
  await atomicJson(file, record);
  return record;
}

export async function listDesktopRequests(directory) {
  const folder = path.join(directory, 'requests');
  let names;
  try { names = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter(name => /^[a-f0-9]{32}\.json$/.test(name)).map(name => readJson(path.join(folder,name))));
  const active = record => ['pending','running','expired'].includes(record.status) ? 1 : 0;
  return records.filter(Boolean).map(record => ({...record, status:record.status === 'pending' && Date.now() - record.createdAt > REQUEST_TTL ? 'expired' : record.status})).sort((a,b) => active(b)-active(a) || b.createdAt-a.createdAt).slice(0,100);
}

export async function decideDesktopRequest(directory, id, approved) {
  if (!ID.test(id) || typeof approved !== 'boolean') throw Error('确认请求无效');
  const record = await readJson(path.join(directory, 'requests', id + '.json'));
  if (!record || record.status !== 'pending' || Date.now() - record.createdAt > REQUEST_TTL) throw Error('请求已处理或已过期');
  // This file is written only by the local UI path. Remote messages never choose an approval.
  const file = path.join(directory, 'decisions', id + '.json');
  await mkdir(path.dirname(file), {recursive:true});
  try { await writeFile(file, JSON.stringify({approved}), {flag:'wx', mode:0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// The remote result is deliberately assembled field by field. Local paths and
// exception messages are never part of a tool response.
export function remoteDesktopResult(id, status, code) {
  if (!ID.test(id) || !['pending','completed','denied','failed','expired'].includes(status)) throw Error('操作状态无效');
  const result = {id, status};
  if (code && ['TRANSFER_FAILED','OPEN_FAILED','REQUEST_EXPIRED','LOCAL_UNAVAILABLE'].includes(code)) result.code = code;
  return result;
}
