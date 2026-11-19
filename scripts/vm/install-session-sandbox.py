import hashlib
import json
from pathlib import Path
import paramiko

root=Path(__file__).resolve().parent
file=root/'downloads/bubblewrap_0.12.0_amd64.deb'
expected='70aca4fa8daeacb677ec00e8063eb586f08ae3d94b1f11e684370b5524c43431'
assert hashlib.sha256(file.read_bytes()).hexdigest()==expected
cfg=json.loads((root/'instance/vm.json').read_text(encoding='utf-8-sig'))
client=paramiko.SSHClient();client.load_host_keys(cfg['knownHosts'])
client.connect('127.0.0.1',port=cfg['sshPort'],username='dshvm',key_filename=cfg['identity'],allow_agent=False,look_for_keys=False,timeout=10)
def run(cmd):
    _,out,err=client.exec_command(cmd);text=out.read().decode();error=err.read().decode();assert out.channel.recv_exit_status()==0,error;return text.strip()
assert run('cat /etc/dsh-vm-executor')==cfg['instanceId']
target='/home/dshvm/.local/share/dsh-sandbox/bubblewrap-0.12.0'
run('mkdir -p '+target)
sftp=client.open_sftp();sftp.put(str(file),target+'/package.deb');sftp.close()
assert run('sha256sum '+target+'/package.deb').split()[0]==expected
run('dpkg-deb -x '+target+'/package.deb '+target)
version=run(target+'/usr/bin/bwrap --version')
probe=run(target+'/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --disable-userns --new-session --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp -- /usr/bin/python3 -c "import os; print(os.getuid()); print(os.getpid())"')
client.close()
report={'version':version,'sha256':expected,'probe':probe,'installedIn':'dedicated Linux VM user directory'}
(root/'instance/sandbox-install.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
