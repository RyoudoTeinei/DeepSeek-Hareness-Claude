"""Create an independent QEMU/WHPX Linux executor, using verified downloaded assets."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import uuid

root=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plugin-root',type=Path,default=root.parent.parent,help='Path to this plugin checkout when running from an external runtime directory')
options=parser.parse_args()
sys.path.insert(0,str(root/'downloads/pycdlib-1.14.0-py2.py3-none-any.whl'))
import pycdlib

private=root/'instance'
private.mkdir(exist_ok=True)
if (private/'vm.json').exists():
    raise SystemExit('VM configuration already exists; preserve it and use start-vm.ps1')

qemu=next((root/'cage-runtime').rglob('qemu-system-x86_64.exe'))
qemu_img=qemu.with_name('qemu-img.exe')
instance=str(uuid.uuid4())
for name in ('user_key','host_key'):
    subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','dsh-vm-executor','-f',str(private/name)],check=True)
public=(private/'user_key.pub').read_text().strip()
worker=(options.plugin_root/'vm-worker.py').read_bytes()
seed={
 'hostname':'dsh-executor','manage_etc_hosts':True,'disable_root':True,'ssh_pwauth':False,
 'users':[{'name':'dshvm','lock_passwd':True,'shell':'/bin/bash','sudo':False,'ssh_authorized_keys':[public]}],
 'ssh_keys':{'ed25519_private':(private/'host_key').read_text(),'ed25519_public':(private/'host_key.pub').read_text().strip()},
 'package_update':True,'packages':['sshfs','python3'],
 'write_files':[
  {'path':'/etc/dsh-vm-executor','content':instance+'\n','permissions':'0644'},
  {'path':'/opt/dsh-vm/vm-worker.py','content':base64.b64encode(worker).decode(),'encoding':'b64','permissions':'0755'},
 ],
 'runcmd':[['mkdir','-p','/workspaces'],['chown','dshvm:dshvm','/workspaces'],['touch','/var/lib/dsh-vm-ready']],
 'final_message':'DSH_EXECUTOR_BOOTSTRAP_COMPLETE',
}
iso=pycdlib.PyCdlib();iso.new(interchange_level=3,joliet=3,vol_ident='cidata')
for name,data in [('user-data',('#cloud-config\n'+json.dumps(seed)).encode()),('meta-data',json.dumps({'instance-id':instance,'local-hostname':'dsh-executor'}).encode())]:
    iso.add_fp(io.BytesIO(data),len(data),iso_path='/'+name.upper().replace('-','_')+';1',joliet_path='/'+name)
iso.write(str(private/'seed.iso'));iso.close()
image=(root/'downloads/debian-13-generic-amd64.qcow2').resolve()
subprocess.run([str(qemu_img),'create','-f','qcow2','-F','qcow2','-b',str(image),str(private/'disk.qcow2'),'12G'],check=True)
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
ssh_port,qmp_port=port(),port()
host_public=(private/'host_key.pub').read_text().split()
(private/'known_hosts').write_text(f'[127.0.0.1]:{ssh_port} {host_public[0]} {host_public[1]}\n')
cfg={'instanceId':instance,'qemu':str(qemu),'directory':str(private),'sshPort':ssh_port,'qmpPort':qmp_port,
     'identity':str(private/'user_key'),'knownHosts':str(private/'known_hosts'),'memoryMiB':2048,'cpus':2,'network':'bootstrap'}
(private/'vm.json').write_text(json.dumps(cfg,indent=2))
print(json.dumps({'instanceId':instance,'sshPort':ssh_port,'memoryMiB':2048,'cpus':2}))
