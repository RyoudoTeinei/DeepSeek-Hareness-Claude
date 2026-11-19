"""Restricted SFTP over existing SSH pipes; exports exactly one selected folder.

No listening port, SSH agent, home directory or host command execution is exposed.
"""
import argparse
import errno
import logging
import os
from pathlib import Path
import stat
import sys
import paramiko


class ProjectFiles(paramiko.SFTPServerInterface):
    def __init__(self, server, root, readonly=False):
        super().__init__(server)
        self.root=Path(root).resolve(strict=True)
        if not self.root.is_dir() or self.root.parent==self.root:
            raise ValueError('A project folder is required')
        self.readonly=readonly
        identity=self.root.stat();self.identity=(identity.st_dev,identity.st_ino)

    def local(self,path,root_ok=True):
        identity=self.root.lstat()
        if (identity.st_dev,identity.st_ino)!=self.identity or self.root.resolve()!=self.root or getattr(identity,'st_file_attributes',0)&0x400:
            raise PermissionError('Shared root identity changed')
        if not isinstance(path,str) or '\x00' in path or '\\' in path or len(path)>1024:
            raise PermissionError('Invalid shared path')
        parts=path.lstrip('/').split('/')
        if parts in ([''],['.']):
            if root_ok:return self.root
            raise PermissionError('Cannot modify share root')
        if any(p in ('','.','..') or any(ord(c)<32 or c in '<>:"|?*' for c in p) or p.endswith(('.', ' ')) for p in parts):
            raise PermissionError('Invalid shared path')
        target=self.root
        for part in parts:
            if part.split('.')[0].upper() in {'CON','PRN','AUX','NUL','CONIN$','CONOUT$','CLOCK$',*(f'COM{i}' for i in '0123456789¹²³'),*(f'LPT{i}' for i in '0123456789¹²³')}:
                raise PermissionError('Reserved filename')
            target=target/part
            try:
                info=target.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
                    raise PermissionError('Links and reparse points are not shared')
                if stat.S_ISREG(info.st_mode) and info.st_nlink>1:
                    raise PermissionError('Hard-linked files are not shared')
            except FileNotFoundError:pass
        if not target.resolve().is_relative_to(self.root):raise PermissionError('Outside shared directory')
        return target

    def error(self,error):
        return paramiko.SFTPServer.convert_errno(getattr(error,'errno',None) or errno.EACCES)

    def writable(self):
        if self.readonly:raise PermissionError('Read-only share')

    def canonicalize(self,path):
        try:
            relative=self.local(path).relative_to(self.root).as_posix()
            return '/' if relative=='.' else '/'+relative
        except OSError:return '/'

    def stat(self,path):
        try:return paramiko.SFTPAttributes.from_stat(self.local(path).stat())
        except OSError as error:return self.error(error)

    lstat=stat

    def list_folder(self,path):
        try:
            result=[]
            for item in self.local(path).iterdir():
                if len(result)>=10000:return paramiko.SFTP_FAILURE
                try:info=paramiko.SFTPAttributes.from_stat(self.local(item.relative_to(self.root).as_posix()).stat())
                except (PermissionError,FileNotFoundError):continue
                info.filename=item.name;result.append(info)
            return result
        except OSError as error:return self.error(error)

    def open(self,path,flags,attr):
        try:
            if flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND):self.writable()
            target=self.local(path,root_ok=False)
            descriptor=os.open(target,flags|getattr(os,'O_BINARY',0),0o600)
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                os.close(descriptor);raise PermissionError('Only regular files are shared')
            mode='r+b' if flags&os.O_RDWR else 'wb' if flags&os.O_WRONLY else 'rb'
            file=os.fdopen(descriptor,mode,buffering=0)
            handle=paramiko.SFTPHandle(flags)
            if mode!='wb':handle.readfile=file
            if mode!='rb':handle.writefile=file
            handle.stat=lambda:paramiko.SFTPAttributes.from_stat(os.fstat(file.fileno()))
            handle.chattr=lambda attrs:self.change(target,attrs)
            return handle
        except OSError as error:return self.error(error)

    def change(self,target,attr):
        try:
            self.writable()
            if attr.st_size is not None:
                with target.open('r+b') as file:file.truncate(attr.st_size)
            if attr.st_atime is not None and attr.st_mtime is not None:os.utime(target,(attr.st_atime,attr.st_mtime))
            # Guest chmod/chown must not change Windows ACLs or host ownership.
            return paramiko.SFTP_OK
        except OSError as error:return self.error(error)

    def chattr(self,path,attr):
        try:return self.change(self.local(path,root_ok=False),attr)
        except OSError as error:return self.error(error)

    def remove(self,path):
        try:self.writable();self.local(path,root_ok=False).unlink();return paramiko.SFTP_OK
        except OSError as error:return self.error(error)

    def mkdir(self,path,attr):
        try:self.writable();self.local(path,root_ok=False).mkdir();return paramiko.SFTP_OK
        except OSError as error:return self.error(error)

    def rmdir(self,path):
        try:self.writable();self.local(path,root_ok=False).rmdir();return paramiko.SFTP_OK
        except OSError as error:return self.error(error)

    def rename(self,old,new):
        try:
            self.writable();target=self.local(new,root_ok=False)
            if target.exists():return paramiko.SFTP_FAILURE
            self.local(old,root_ok=False).rename(target);return paramiko.SFTP_OK
        except OSError as error:return self.error(error)

    def posix_rename(self,old,new):
        try:self.writable();os.replace(self.local(old,root_ok=False),self.local(new,root_ok=False));return paramiko.SFTP_OK
        except OSError as error:return self.error(error)


class PipeChannel:
    def recv(self,size):return sys.stdin.buffer.read1(size)
    def send(self,data):sys.stdout.buffer.write(data);sys.stdout.buffer.flush();return len(data)
    def get_transport(self):return self
    def get_log_channel(self):return 'dsh.vm.sftp'
    def get_hexdump(self):return False
    def get_name(self):return 'stdio'
    def close(self):pass


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--read-only',action='store_true');args=parser.parse_args()
    logging.basicConfig(level=logging.ERROR,stream=sys.stderr)
    channel=PipeChannel()
    service=paramiko.SFTPServer(channel,'sftp',None,sftp_si=ProjectFiles,root=args.root,readonly=args.read_only)
    try:service.start_subsystem('sftp',channel,channel)
    finally:service.finish_subsystem()
