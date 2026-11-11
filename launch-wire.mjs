export function decodeLaunch(argv){
  if(argv[0]==='--launch'){
    const value=JSON.parse(Buffer.from(argv[1]||'','base64').toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('启动参数无效');
    return value;
  }
  const [action,host,project,identity='',sessionId='',desktopMode='']=argv;
  return {action,host,project,identity,sessionId,desktopMode};
}
