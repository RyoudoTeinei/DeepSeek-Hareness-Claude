export function terminalFromReady(output,scope){
 const frames=output.split('\n').filter(line=>line.startsWith('DSH_AGENT:')).map(line=>JSON.parse(line.slice(10)));
 const ready=frames.find(frame=>frame.type==='native_ready');
 if(!ready||!['dsh-native-'+scope,'dsh-vm-native-'+scope].includes(ready.session))throw Error(frames.find(frame=>frame.type==='broker_error')?.message||'原生 Claude 终端尚未就绪');
 return ready.session;
}
export function attachCommand(name){
 if(!/^dsh-(?:vm-)?native-[a-f0-9]{32}$/.test(name))throw Error('终端会话标识无效');
 return 'export TERM=xterm-256color; exec tmux attach-session -d -t ='+name;
}
