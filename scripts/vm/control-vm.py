import argparse
import json
from pathlib import Path
import socket
import time

root=Path(__file__).resolve().parent
cfg=json.loads((root/'instance/vm.json').read_text(encoding='utf-8-sig'))
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['status','powerdown']);args=parser.parse_args()
with socket.create_connection(('127.0.0.1',cfg['qmpPort']),timeout=5) as conn:
    file=conn.makefile('rwb',buffering=0)
    def receive():return json.loads(file.readline())
    def request(command,arguments=None):
        value={'execute':command}
        if arguments is not None:value['arguments']=arguments
        file.write((json.dumps(value)+'\n').encode())
        while True:
            response=receive()
            if 'return' in response:return response['return']
            if 'error' in response:raise ValueError(response['error'])
    receive();request('qmp_capabilities')
    identity=request('query-uuid')['UUID']
    if identity!=cfg['instanceId']:raise ValueError('Refusing to control a different VM')
    if args.action=='status':print(json.dumps(request('query-status')))
    else:
        request('system_powerdown');print('Powerdown requested for the dedicated VM only')
