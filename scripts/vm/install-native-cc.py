"""Verify official Linux artifacts, then copy only to our pinned guest over SSH."""
import compression.zstd
import hashlib
import json
from pathlib import Path
import shutil
import paramiko

root=Path(__file__).resolve().parent
version='2.1.322'
archive=root/f'downloads/claude-{version}-linux-x64.zst'
binary=root/f'downloads/claude-{version}-linux-x64'
def digest(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
for suffix,file in [('.zst',archive)]:
    manifest=json.loads((root/f'downloads/claude-{version}-manifest{suffix}.json').read_text())['platforms']['linux-x64']
    assert file.stat().st_size==manifest['size'] and digest(file)==manifest['checksum'], 'Archive verification failed'
manifest=json.loads((root/f'downloads/claude-{version}-manifest.json').read_text())['platforms']['linux-x64']
if not binary.exists():
    with compression.zstd.open(archive,'rb') as source,binary.open('xb') as target:shutil.copyfileobj(source,target)
assert binary.stat().st_size==manifest['size'] and digest(binary)==manifest['checksum'], 'Binary verification failed'
cfg=json.loads((root/'instance/vm.json').read_text(encoding='utf-8-sig'))
assert cfg['network']=='isolated'
client=paramiko.SSHClient();client.load_host_keys(cfg['knownHosts'])
client.connect('127.0.0.1',port=cfg['sshPort'],username='dshvm',key_filename=cfg['identity'],allow_agent=False,look_for_keys=False,timeout=10)
def run(command):
    _,stdout,stderr=client.exec_command(command)
    value=stdout.read().decode();error=stderr.read().decode()
    assert stdout.channel.recv_exit_status()==0,error
    return value.strip()
assert run('cat /etc/dsh-vm-executor')==cfg['instanceId']
target=f'/home/dshvm/.local/share/dsh-cc-native/{version}'
run('mkdir -p '+target)
sftp=client.open_sftp()
sftp.put(str(binary),target+'/claude.upload');sftp.chmod(target+'/claude.upload',0o700)
assert run('sha256sum '+target+'/claude.upload').split()[0]==manifest['checksum']
run('mv '+target+'/claude.upload '+target+'/claude')
sftp.close();client.close()
report={'version':version,'sha256':manifest['checksum'],'guestInstance':cfg['instanceId'],'network':'isolated','installedIn':'dedicated-linux-vm'}
(root/'instance/native-cc-install.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
