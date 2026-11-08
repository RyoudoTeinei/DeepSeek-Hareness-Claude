"""Conservative, persistent two-endpoint file synchronization.

State and recovery files live outside the project roots. Only UTF-8 text is
normalized. Every destination replacement is captured and checked before commit.
"""
from __future__ import annotations
import argparse
import base64
import contextlib
import difflib
import fnmatch
import hashlib
import json
import shutil
import signal
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import threading
import logging
from logging.handlers import RotatingFileHandler
import uuid
from project_rules import ProjectRules, DEFAULT_PRESETS, extension_policy, validate_presets

DEFAULT_IGNORES = [
    ".git", ".svn", ".hg", "node_modules", ".venv", "__pycache__", ".cache",
    ".env", ".env.*", "*.pem", "*.key", "checkpoints", "datasets",
]
MISSING = {"raw": None, "content": None, "kind": "missing"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def text_content(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any(ord(c) < 32 and c not in "\n\r\t" for c in text):
        return None
    return text.replace("\r\n", "\n")


def describe(data, mode=0o644, policy=None):
    text = None if (policy or {}).get("binary") else text_content(data)
    return {"raw": digest(data), "content": digest(text.encode()) if text is not None else digest(data),
            "kind": "text" if text is not None else "binary", "mode": mode,
            "eol": "crlf" if b"\r\n" in data else "lf", "size": len(data)}


def ignored(name, patterns):
    if any(part.startswith(".dsh-stage-") or part in (".git",".hg",".svn",".dsh-smart-sync-recovery",".dsh-sync") for part in Path(name).parts):
        return True
    return any(fnmatch.fnmatchcase(part, pattern)
               for part in Path(name).parts for pattern in patterns)


def invalid_windows_path(name):
    reserved = {"CON", "PRN", "AUX", "NUL"} | {
        prefix + str(i) for prefix in ("COM", "LPT") for i in range(1, 10)}
    for part in name.split("/"):
        if (part.endswith((" ", ".")) or any(c in '<>:"\\|?*' or ord(c) < 32 for c in part)
                or part.split(".")[0].upper() in reserved):
            return True
    return False


class PauseRequested(Exception):
    pass


class Changed(Exception):
    pass


def publish_exclusive(source, destination):
    # Windows rename refuses existing destinations and avoids hard-link ACL
    # restrictions. POSIX link gives the same no-overwrite behavior.
    if os.name == "nt":
        os.rename(source, destination)
    else:
        os.link(source, destination)


@contextlib.contextmanager
def exclusive_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as f:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            f.write(b"0")
            f.flush()
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


class Endpoint:
    def __init__(self, root, recovery, recover_on_start=True):
        self.root = Path(root).resolve()
        self.recovery = Path(recovery).resolve()
        if self.recovery == self.root:
            raise ValueError("Backup directory cannot be the project root")
        if self.root in self.recovery.parents and self.recovery.relative_to(self.root).parts[0]!=".dsh-sync":
            raise ValueError("Project-internal backups must be inside .dsh-sync")
        if not self.root.is_dir():
            raise ValueError("Synchronization root does not exist")
        self.recovery.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.stat().st_dev != self.recovery.stat().st_dev:
            raise ValueError("备份目录必须与项目位于同一文件系统，请重新扫描以更新备份位置")
        self.before_capture = None  # fault-injection seam for competing writers
        if recover_on_start:self.recover()

    def recover(self):
        for journal in self.recovery.glob("*.pending.json"):
            entry = json.loads(journal.read_text())
            if entry["root"] != str(self.root):
                raise Changed("Recovery journal belongs to a different root")
            backup = self.recovery / entry["backup"]
            target = self.path(entry["path"])
            if backup.exists() and not target.exists():
                target.parent.mkdir(parents=True,exist_ok=True)
                try:
                    publish_exclusive(backup,target)
                except FileExistsError:
                    pass
            os.replace(journal,journal.with_name(journal.name.replace(".pending.json",".json")))

    def path(self, name):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or not name or name == ".":
            raise ValueError("Unsafe relative path")
        target = self.root / relative
        for p in [target, *target.parents]:
            if p == self.root:
                break
            if p.is_symlink():
                raise Changed("Symbolic link is excluded: " + name)
        return target

    def read(self, name, expected=None, maximum=None):
        p = self.path(name)
        try:
            before = p.stat()
            if not stat.S_ISREG(before.st_mode):
                raise Changed("Path is not a regular file")
            cap=maximum if maximum is not None else (expected or {}).get("size",104857600)
            if before.st_size>cap:raise Changed("File grew beyond allowed read size")
            with p.open("rb") as f:data=f.read(cap+1)
            if len(data)>cap:raise Changed("File grew during read")
            after = p.stat()
            if (before.st_ino, before.st_size, before.st_mtime_ns) != (
                    after.st_ino, after.st_size, after.st_mtime_ns):
                raise Changed("File changed while reading")
        except FileNotFoundError:
            data = None
        raw = digest(data) if data is not None else None
        if expected is not None and raw != expected["raw"]:
            raise Changed("File changed after scan")
        return data

    def probe(self,name,patterns,limit,presets=None):
        target=self.path(name)
        if ignored(name,patterns):return {"kind":"excluded","reason":"path ignore"}
        if not target.exists():return MISSING.copy()
        policy=ProjectRules(self.root,self.recovery).resolve([name])[name]
        extension=extension_policy(name,DEFAULT_PRESETS if presets is None else presets,limit)
        if policy["ignore"] or policy["problem"] or not extension["enabled"]:
            return {"kind":"excluded","reason":policy["problem"] or "file excluded by rules"}
        if target.stat().st_size>extension["limit"]:return {"kind":"excluded","reason":"size limit"}
        data=self.read(name,maximum=extension["limit"])
        if data is None:return MISSING.copy()
        return {**describe(data,stat.S_IMODE(target.stat().st_mode),policy),"policy":policy}

    def scan(self, patterns, limit, presets=None):
        if not self.root.is_dir():
            raise Changed("Synchronization root unavailable; refusing to infer deletions")
        if not isinstance(limit,int) or limit<1:
            raise ValueError("File limit must be positive bytes")
        presets=DEFAULT_PRESETS if presets is None else validate_presets(presets)
        records, candidates, updated = {}, {}, {}
        cache_path=self.recovery/"scan-cache.json"
        try:
            stored=json.loads(cache_path.read_text())
            cache=stored["files"] if stored["root"]==str(self.root) else {}
        except (OSError,ValueError,KeyError):
            cache={}
        def scan_error(error):
            raise error
        for base, dirs, files in os.walk(self.root,onerror=scan_error):
            for name in list(dirs):
                p=Path(base)/name
                rel=p.relative_to(self.root).as_posix()
                if ignored(rel,patterns) or p.is_symlink():
                    records[rel]={"kind":"excluded","reason":"pattern or symlink"}
                    dirs.remove(name)
            for name in files:
                p=Path(base)/name
                rel=p.relative_to(self.root).as_posix()
                if ignored(rel,patterns) or p.is_symlink():
                    records[rel]={"kind":"excluded","reason":"pattern or symlink"}
                else:
                    candidates[rel]=p
        policies=ProjectRules(self.root,self.recovery).resolve(list(candidates))
        for rel,p in candidates.items():
            policy=policies[rel]
            extension=extension_policy(rel,presets,limit)
            file_limit=extension["limit"]
            try:
                metadata=p.stat()
                if not extension["enabled"]:
                    records[rel]={"kind":"excluded","reason":"extension preset","preset":extension["preset"]}
                elif policy["problem"] or policy["ignore"]:
                    records[rel]={"kind":"excluded","reason":policy["problem"] or "project ignore or Git LFS"}
                elif metadata.st_size>file_limit:
                    records[rel]={"kind":"excluded","reason":"size limit","size":metadata.st_size,"limit":file_limit,"preset":extension["preset"]}
                else:
                    signature=[metadata.st_dev,metadata.st_ino,metadata.st_size,
                               metadata.st_mtime_ns,metadata.st_ctime_ns,metadata.st_mode,policy]
                    cached=cache.get(rel,{})
                    if cached.get("signature")==signature and time.time()-cached.get("time",0)<300:
                        records[rel]=cached["record"]
                        updated[rel]=cached
                    else:
                        data=self.read(rel,maximum=file_limit)
                        if data is not None:
                            records[rel]=describe(data,stat.S_IMODE(metadata.st_mode),policy)
                            records[rel]["policy"]=policy
                            updated[rel]={"signature":signature,"time":time.time(),"record":records[rel]}
            except (OSError,Changed) as e:
                records[rel]={"kind":"excluded","reason":str(e)}
        temp=cache_path.with_name("scan-cache-"+uuid.uuid4().hex+".tmp")
        temp.write_text(json.dumps({"root":str(self.root),"files":updated}))
        os.replace(temp,cache_path)
        return records

    def cleanup(self,protected,days=7,max_bytes=2*1024**3,keep=2):
        if days<0 or max_bytes<0 or keep<1:raise ValueError("Invalid retention policy")
        groups={}
        protected=set(protected)
        # Completed records only. Pending journal and its data are never eligible.
        for journal in self.recovery.glob("*.json"):
            if journal.name.endswith(".pending.json") or journal.name=="scan-cache.json":continue
            try:
                entry=json.loads(journal.read_text())
                if entry.get("root")!=str(self.root) or "backup" not in entry:continue
                backup=self.recovery/entry["backup"]
                if backup.parent!=self.recovery or backup.is_symlink():continue
                size=backup.stat().st_size if backup.exists() else 0
                groups.setdefault(entry["path"],[]).append((journal.stat().st_mtime,journal,backup,size))
            except (OSError,ValueError,KeyError):continue
        total=sum(row[3] for rows in groups.values() for row in rows)
        eligible=[]
        for name,rows in groups.items():
            rows.sort(reverse=True)
            if name not in protected:eligible.extend(rows[keep:])
        removed=0
        for timestamp,journal,backup,size in sorted(eligible):
            if time.time()-timestamp<days*86400 and total<=max_bytes:continue
            backup.unlink(missing_ok=True)
            journal.unlink()
            total-=size
            removed+=1
        policy=self.recovery/"retention.json"
        policy.write_text(json.dumps({"max_bytes":max_bytes}))
        return {"removed":removed,"retained_bytes":total,"over_budget":total>max_bytes}

    def write(self, name, data, expected, mode):
        target = self.path(name)
        policy=self.recovery/"retention.json"
        budget=json.loads(policy.read_text()).get("max_bytes",2*1024**3) if policy.exists() else 2*1024**3
        usage=sum(p.stat().st_size for p in self.recovery.glob("*.data"))
        if expected.get("size",0)+usage>budget:
            raise Changed("Backup budget exhausted; increase budget or review retained versions")
        required=(len(data) if data else 0)+64*1024*1024
        if shutil.disk_usage(self.root).free<required:
            raise Changed("Insufficient disk reserve; write postponed")
        self.read(name, expected)
        target.parent.mkdir(parents=True, exist_ok=True)
        self.path(name)
        backup = self.recovery / (uuid.uuid4().hex + ".data")
        journal = backup.with_suffix(".pending.json")
        with journal.open("w") as f:
            json.dump({"root":str(self.root),"backup":backup.name,"path":name,
                       "expected":expected["raw"],"operation":"delete" if data is None else "write"},f)
            f.flush()
            os.fsync(f.fileno())
        staged = None
        if data is not None:
            fd, temp = tempfile.mkstemp(prefix=".dsh-stage-", dir=target.parent)
            staged = Path(temp)
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            staged.chmod(mode)
        captured = False
        try:
            if self.before_capture:
                self.before_capture(target)
            if expected["raw"] is not None:
                # Capture the actual destination before checking, preserving a
                # concurrent edit that happened after the initial comparison.
                os.rename(target, backup)
                captured = True
                if digest(backup.read_bytes()) != expected["raw"]:
                    raise Changed("Concurrent destination edit saved in recovery")
            elif target.exists():
                raise Changed("Destination appeared during synchronization")
            if data is not None:
                # link is exclusive: never overwrite a file created in the gap.
                publish_exclusive(staged, target)
            elif target.exists():
                raise Changed("Destination was recreated during deletion")
        except Exception:
            if captured:
                try:
                    publish_exclusive(backup, target)
                except FileExistsError:
                    pass  # both competing versions are retained
            raise
        finally:
            if staged is not None:
                staged.unlink(missing_ok=True)
        os.replace(journal,journal.with_name(journal.name.replace(".pending.json",".json")))
        return str(backup) if captured else None


class SSH:
    """JSON RPC to this same file on a user-controlled SSH host."""
    def __init__(self, host, script, root, recovery, identity=None):
        self.host, self.script, self.root, self.recovery = host, script, root, recovery
        self.identity=identity
        self.process = None

    def command(self, mode):
        import shlex
        identity_args = ["-i", self.identity, "-o", "IdentitiesOnly=yes"] if self.identity else []
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "StrictHostKeyChecking=yes", *identity_args, self.host,
                "python3 " + shlex.quote(self.script) + " " + mode]

    @contextlib.contextmanager
    def session(self):
        # Older deployed peers still support the one-request protocol.
        with subprocess.Popen(self.command("rpc-stream"), stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, encoding="utf-8") as process:
            try:
                if self.exchange(process) == {"ready": True}:
                    self.process = process
                yield
            finally:
                self.process = None
                if process.poll() is None:
                    process.kill()

    @staticmethod
    def exchange(process, request=None):
        timer = threading.Timer(120, process.kill)
        timer.start()
        try:
            if request is not None:
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
            line = process.stdout.readline()
            if not line and request is not None:
                raise Changed("SSH connection closed; rescan to check what was applied")
            return json.loads(line) if line else None
        finally:
            timer.cancel()

    def request(self, action, **kw):
        request = {"root": self.root, "recovery": self.recovery, "action": action, **kw}
        if self.process is not None:
            reply = self.exchange(self.process, request)
        else:
            result = subprocess.run(self.command("rpc"), input=json.dumps(request),
                                    capture_output=True, text=True, encoding="utf-8", timeout=120)
            if result.returncode:
                raise Changed(result.stderr.strip() or "SSH disconnected")
            reply = json.loads(result.stdout)
        if "error" in reply:
            raise Changed(reply["error"])
        return reply["result"]

    def scan(self, patterns, limit, presets=None):
        return self.request("scan", patterns=patterns, limit=limit, presets=presets)

    def probe(self,name,patterns,limit,presets=None):
        try:return self.request("probe",name=name,patterns=patterns,limit=limit,presets=presets)
        except Changed as e:
            if "Unknown action" not in str(e):raise
            return self.scan(patterns,limit,presets).get(name,MISSING.copy())

    def cleanup(self,protected,days=7,max_bytes=2*1024**3,keep=2):
        return self.request("cleanup",protected=protected,days=days,max_bytes=max_bytes,keep=keep)

    def read(self, name, expected=None, maximum=None):
        value = self.request("read", name=name, expected=expected, maximum=maximum)
        return base64.b64decode(value) if value is not None else None

    def write(self, name, data, expected, mode):
        return self.request("write", name=name, data=base64.b64encode(data).decode() if data is not None else None,
                            expected=expected, mode=mode)


def merged_text(base, left, right):
    """Only non-overlapping line edits; ambiguous edits require a person."""
    lines = base.splitlines(keepends=True)
    edits = []
    for side in (left, right):
        new = side.splitlines(keepends=True)
        for tag, i, j, k, l in difflib.SequenceMatcher(None, lines, new, autojunk=False).get_opcodes():
            if tag != "equal":
                candidate = (i, j, new[k:l])
                if candidate in edits:
                    continue
                for a, b, _ in edits:
                    if max(a, i) <= min(b, j):
                        return None
                edits.append(candidate)
    for i, j, replacement in sorted(edits, reverse=True):
        lines[i:j] = replacement
    return "".join(lines)


class Engine:
    def __init__(self, left, right, state, patterns=None, limit=100*1024*1024,
                 auto_merge=False, settle=1.0, retention=None, presets=None):
        self.left, self.right = left, right
        self.state = Path(state)
        for endpoint in (left,right):
            if isinstance(endpoint,Endpoint):
                location=self.state.resolve()
                if location==endpoint.root or (endpoint.root in location.parents and location.relative_to(endpoint.root).parts[0]!=".dsh-sync"):
                    raise ValueError("Project-internal state must be inside .dsh-sync")
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.patterns = DEFAULT_IGNORES if patterns is None else patterns
        self.limit, self.auto_merge, self.settle = limit, auto_merge, settle
        self.retention=retention or {"days":7,"max_bytes":2*1024**3,"keep":2}
        self.last_cleanup=0
        self.watch_mode = False
        self.last_progress = 0.0
        self.presets=DEFAULT_PRESETS if presets is None else validate_presets(presets)
        self.db = sqlite3.connect(self.state / "state.sqlite")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS baseline(path TEXT PRIMARY KEY, hash TEXT, text TEXT)")
        columns={row[1] for row in self.db.execute("PRAGMA table_info(baseline)")}
        if "policy" not in columns:self.db.execute("ALTER TABLE baseline ADD COLUMN policy TEXT")
        self.db.execute("CREATE TABLE IF NOT EXISTS pending(path TEXT PRIMARY KEY, payload TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT)")
        def identity(endpoint):
            if isinstance(endpoint, SSH):
                return [endpoint.host,endpoint.root,endpoint.recovery]
            return [str(endpoint.root),str(endpoint.recovery)]
        binding=json.dumps([identity(left),identity(right)])
        previous=self.db.execute("SELECT value FROM metadata WHERE key='endpoints'").fetchone()
        if previous and previous[0]!=binding:
            self.db.close()
            raise ValueError("State belongs to different endpoints")
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES('endpoints',?)",(binding,))
        self.db.commit()

    def close(self):
        self.db.close()

    def save_baseline(self, name, data, policy=None):
        canonical = text_content(data) if data is not None and not (policy or {}).get("binary") else None
        value = describe(data,policy=policy)["content"] if data is not None else None
        if canonical is not None and len(canonical.encode()) > 1024*1024:
            canonical = None
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO baseline(path,hash,text,policy) VALUES(?,?,?,?)",
                            (name,value,canonical,json.dumps({"binary":bool((policy or {}).get("binary"))})))
            self.db.execute("DELETE FROM pending WHERE path=?", (name,))

    def transfer(self, name, data, l, r, source=None):
        # Persist intent before the first destination write; crashes preserve
        # the old baseline so an incomplete merge can be recovered or flagged.
        policy=(source or l if l["raw"] is not None else r).get("policy",{})
        payload = {"left": l.get("raw"), "right": r.get("raw"),
                   "desired": describe(data,policy=policy)["content"] if data is not None else None}
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO pending VALUES(?,?)", (name, json.dumps(payload)))
        written_sizes = []
        for endpoint, current in ((self.left, l), (self.right, r)):
            out = data
            if data is not None and not policy.get("binary") and text_content(data) is not None:
                canonical = text_content(data)
                desired_eol=current.get("policy",policy).get("eol","preserve")
                if desired_eol=="preserve":desired_eol=current.get("eol",(source or {}).get("eol","lf"))
                out = canonical.replace("\n", "\r\n").encode() if desired_eol=="crlf" else canonical.encode()
            written_sizes.append(len(out) if out is not None else 0)
            desired = digest(out) if out is not None else None
            if current["raw"] != desired:
                endpoint.write(name, out, current, current.get("mode", (source or {}).get("mode", 0o644)))
        # Verify both endpoints before advancing the baseline.
        a = self.left.read(name, maximum=written_sizes[0])
        b = self.right.read(name, maximum=written_sizes[1])
        wanted = describe(data,policy=policy)["content"] if data is not None else None
        if any((describe(x,policy=policy)["content"] if x is not None else None) != wanted for x in (a,b)):
            raise Changed("Concurrent edit after transfer; baseline retained")
        self.save_baseline(name, data,policy)

    def checkpoint(self, phase, current=0, total=0, name=None):
        if self.watch_mode and (self.state / "stop.request").exists():
            raise PauseRequested()
        now = time.time()
        if name is not None and now - self.last_progress < 0.3:
            return
        self.last_progress = now
        if self.watch_mode:
            progress = {"phase": phase, "current": current, "total": total, "path": name}
            target = self.state / "progress.json"
            temporary = target.with_suffix(".next")
            temporary.write_text(json.dumps(progress), encoding="utf-8")
            os.replace(temporary, target)
        elif os.getenv("DSH_PROGRESS"):
            print(f"!P:{phase}.{current}.{total}!", file=sys.stderr, flush=True)

    def plan(self):
        """Read-only project preview; no baseline changes or file writes."""
        with exclusive_lock(self.state/"coordinator.lock"):
            self.checkpoint("local")
            left=self.left.scan(self.patterns,self.limit,self.presets)
            self.checkpoint("remote")
            right=self.right.scan(self.patterns,self.limit,self.presets)
            baseline={p:h for p,h in self.db.execute("SELECT path,hash FROM baseline")}
            names=left.keys()|right.keys()|baseline.keys()
            excluded={p for entries in (left,right) for p,r in entries.items() if r["kind"]=="excluded"}
            folded={}
            for name in names:
                parts=name.split("/")
                for i in range(1,len(parts)+1):
                    prefix="/".join(parts[:i])
                    folded.setdefault(prefix.casefold(),set()).add(prefix)
            collisions={p for group in folded.values() if len(group)>1 for p in group}
            self.checkpoint("compare")
            rows=[]
            for name in sorted(names):
                l,r=left.get(name,MISSING),right.get(name,MISSING)
                if l["kind"]=="excluded" or r["kind"]=="excluded" or ignored(name,self.patterns) or any(name.startswith(p+"/") for p in excluded):
                    status="excluded"
                elif invalid_windows_path(name) or any(name==p or name.startswith(p+"/") for p in collisions):
                    status="blocked"
                elif l["raw"] is not None and r["raw"] is not None and l.get("policy")!=r.get("policy"):
                    status="blocked"
                elif l["content"]==r["content"]:
                    status="equal" if l["raw"]==r["raw"] else "equivalent"
                elif name not in baseline:
                    status="conflict" if l["raw"] is not None and r["raw"] is not None else ("upload" if l["raw"] is not None else "download")
                elif l["content"]==baseline[name]:
                    status="delete-local" if r["raw"] is None else "download"
                elif r["content"]==baseline[name]:
                    status="delete-remote" if l["raw"] is None else "upload"
                else:status="conflict"
                rows.append({"path":name,"status":status,"left":l.get("raw"),"right":r.get("raw"),
                             "reason":l.get("reason") or r.get("reason")})
            return {"time":time.time(),"files":rows,
                    "token":digest(json.dumps(rows,sort_keys=True).encode())}

    def inspect(self, name, diff_offset=0, diff_only=False):
        if type(diff_offset) is not int or diff_offset < 0:
            raise ValueError("Invalid diff page")
        left={name:self.left.probe(name,self.patterns,self.limit,self.presets)}
        right={name:self.right.probe(name,self.patterns,self.limit,self.presets)}
        result={"path":name}
        full_text={}
        for label,endpoint,records in (("left",self.left,left),("right",self.right,right)):
            record=records.get(name,MISSING)
            if record["kind"]=="excluded":raise Changed("File is excluded by synchronization rules")
            data=endpoint.read(name,record)
            text=text_content(data) if data is not None and record["kind"]=="text" else None
            full_text[label]=text
            result[label]={**record,"text":text[:12000] if text is not None and not diff_only else None,
                           "truncated":text is not None and len(text)>12000}
        if all(full_text[k] is not None or result[k]["kind"] == "missing" for k in ("left", "right")):
            chunks=[]
            length=0
            lines = difflib.unified_diff(
                (full_text["right"] or "").splitlines(True),
                (full_text["left"] or "").splitlines(True),
                fromfile="服务器", tofile="本地",
            )
            for index, line in enumerate(lines):
                if index < diff_offset:
                    continue
                if not line.endswith("\n"):
                    line += "\n\\ No newline at end of file\n"
                if len(chunks) >= 120 or (chunks and length + len(line) > 12000):
                    result["next_diff_offset"] = index
                    break
                if len(line) > 12000:
                    line = line[:11970] + "…（此行过长，已截断）\n"
                chunks.append(line)
                length += len(line)
            result["differences"]="".join(chunks)
        return result

    def resolve(self, name, side, expected):
        with exclusive_lock(self.state/"coordinator.lock"):
            left = self.left.scan(self.patterns, self.limit, self.presets)
            right = self.right.scan(self.patterns, self.limit, self.presets)
            return self.resolve_from_scan(name, side, expected, left, right)

    def resolve_batch(self, items):
        if not isinstance(items, list) or not items or len(items) > 200:
            raise ValueError("每批请选择 1 至 200 个文件")
        paths = set()
        for item in items:
            if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                    or not item["path"] or item["path"] in paths
                    or item.get("side") not in ("left", "right")
                    or not isinstance(item.get("expected"), dict)
                    or not all(key in item["expected"] for key in ("left", "right"))):
                raise ValueError("文件选择无效或重复，请重新扫描")
            paths.add(item["path"])
        results = []
        connection = self.right.session() if isinstance(self.right, SSH) else contextlib.nullcontext()
        with exclusive_lock(self.state/"coordinator.lock"), connection:
            left = self.left.scan(self.patterns, self.limit, self.presets)
            right = self.right.scan(self.patterns, self.limit, self.presets)
            for index, item in enumerate(items, 1):
                name = item["path"]
                if os.getenv("DSH_PROGRESS"):
                    print(f"!P:batch.{index}.{len(items)}!", file=sys.stderr, flush=True)
                # Applying a project rule can change eligibility for later files.
                # Keep rule changes in separate operations from ordinary files.
                if len(items) > 1 and name.rsplit("/", 1)[-1] in (".gitignore", ".gitattributes", ".editorconfig"):
                    results.append({"path": name, "error": "项目规则文件请单独处理后重新扫描"})
                    continue
                try:
                    results.append(self.resolve_from_scan(name, item["side"], item["expected"], left, right))
                except (Changed, OSError, ValueError, subprocess.SubprocessError) as error:
                    results.append({"path": name, "error": str(error)})
        return results

    def resolve_from_scan(self, name, side, expected, left, right):
        if side not in ("left", "right"):
            raise ValueError("Choose left or right")
        l,r=left.get(name,MISSING),right.get(name,MISSING)
        if ignored(name, self.patterns):
            raise Changed("File is excluded by synchronization rules")
        for label,current in (("left",l),("right",r)):
            if current["kind"]=="excluded":raise Changed("File is excluded by synchronization rules")
            if label not in expected or current["raw"]!=expected[label]:
                raise Changed("File changed since comparison; inspect again")
        if invalid_windows_path(name):raise Changed("Unsupported Windows filename")
        if l["raw"] is not None and r["raw"] is not None and l.get("policy")!=r.get("policy"):
            raise Changed("Project rules differ; resolve rule files first")
        parts=name.split("/")
        for other in left.keys()|right.keys():
            other_parts=other.split("/")
            for i in range(1,min(len(parts),len(other_parts))+1):
                a,b="/".join(parts[:i]),"/".join(other_parts[:i])
                if a.casefold()==b.casefold() and a!=b:raise Changed("Case collision requires renaming first")
        chosen=l if side=="left" else r
        source=self.left if side=="left" else self.right
        data=source.read(name,chosen)
        self.transfer(name,data,l,r,chosen)
        return {"path":name,"resolved":True,"selected":side}


    def cycle(self):
        with exclusive_lock(self.state / "coordinator.lock"):
            return self._cycle()

    def _cycle(self):
        self.checkpoint("local")
        first_l = self.left.scan(self.patterns, self.limit,self.presets)
        self.checkpoint("remote")
        first_r = self.right.scan(self.patterns, self.limit,self.presets)
        if self.settle:
            time.sleep(self.settle)
        self.checkpoint("local")
        left = self.left.scan(self.patterns, self.limit,self.presets)
        self.checkpoint("remote")
        right = self.right.scan(self.patterns, self.limit,self.presets)
        self.checkpoint("compare")
        baseline = {p:(h,t) for p,h,t in self.db.execute("SELECT path,hash,text FROM baseline")}
        baseline_policies={p:json.loads(v or '{"binary":false}') for p,v in self.db.execute("SELECT path,policy FROM baseline")}
        pending = {p:json.loads(v) for p,v in self.db.execute("SELECT * FROM pending")}
        names = sorted(left.keys() | right.keys() | baseline.keys() | pending.keys())
        folded = {}
        for name in names:
            for prefix_len in range(1,len(name.split("/"))+1):
                prefix = "/".join(name.split("/")[:prefix_len])
                folded.setdefault(prefix.casefold(), set()).add(prefix)
        collisions = {p for values in folded.values() if len(values)>1 for p in values}
        blocked = {p for items in (left,right) for p,v in items.items() if v["kind"] == "excluded"}
        deletion_candidates = [
            p for p,(h,_) in baseline.items() if h is not None and
            ((p not in left and right.get(p,{}).get("content")==h) or
             (p not in right and left.get(p,{}).get("content")==h))]
        deletion_hold = len(deletion_candidates)>=10 and len(deletion_candidates)>=len(baseline)*0.3
        report = []
        for index, name in enumerate(names, 1):
            self.checkpoint("files", index, len(names), name)
            l, r = left.get(name, MISSING), right.get(name, MISSING)
            if ignored(name, self.patterns) or any(name==p or name.startswith(p+"/") for p in blocked):
                excluded=l if l["kind"]=="excluded" else r
                report.append({"path":name,"status":"excluded","reason":l.get("reason") or r.get("reason") or "excluded ancestor",
                               **{k:excluded[k] for k in ("size","limit","preset") if k in excluded}})
                continue
            if invalid_windows_path(name) or any(name==p or name.startswith(p+"/") for p in collisions):
                report.append({"path":name,"status":"blocked","reason":"Windows name collision or unsupported name"})
                continue
            if l != first_l.get(name,MISSING) or r != first_r.get(name,MISSING):
                report.append({"path":name,"status":"retry","reason":"file still changing"})
                continue
            if deletion_hold and name in deletion_candidates:
                report.append({"path":name,"status":"blocked","reason":"bulk deletion requires review"})
                continue
            try:
                if l["raw"] is not None and r["raw"] is not None and l.get("policy")!=r.get("policy"):
                    report.append({"path":name,"status":"blocked","reason":"project policies differ; synchronize rule files first"})
                    continue
                if l["content"] == r["content"]:
                    if any(v["kind"]=="text" and v.get("policy",{}).get("eol") in ("lf","crlf") and
                           v["policy"]["eol"]!=v["eol"] for v in (l,r)):
                        data=self.left.read(name,l)
                        self.transfer(name,data,l,r)
                        report.append({"path":name,"status":"formatted"})
                        continue
                    # Equivalent text can keep endpoint-specific line endings.
                    if name not in baseline or baseline[name][0]!=l["content"] or name in pending:
                        self.left.read(name,l)
                        data = self.right.read(name,r)
                        self.save_baseline(name,data,r.get("policy"))
                    report.append({"path":name,"status":"equivalent" if l["raw"]!=r["raw"] else "equal"})
                    continue
                prior = baseline.get(name)
                current_policy=l.get("policy",r.get("policy",{}))
                policy_changed=bool(current_policy.get("binary"))!=baseline_policies.get(name,{}).get("binary",False)
                if prior and policy_changed:
                    report.append({"path":name,"status":"conflict","reason":"content interpretation changed; review both versions"})
                    continue
                recovered = pending.get(name)
                if (recovered and any(v["content"]==recovered["desired"] for v in (l,r))
                        and all(v["content"]==recovered["desired"] or v["raw"]==recovered[side]
                                for side,v in (("left",l),("right",r)))):
                    chosen = l if l["content"]==recovered["desired"] else r
                    source = self.left if chosen is l else self.right
                elif prior is None:
                    if l["raw"] is not None and r["raw"] is not None:
                        report.append({"path":name,"status":"conflict","reason":"different initial contents; no common baseline"})
                        continue
                    chosen = l if l["raw"] is not None else r
                    source = self.left if chosen is l else self.right
                elif l["content"] == prior[0]:
                    chosen, source = r, self.right
                elif r["content"] == prior[0]:
                    chosen, source = l, self.left
                else:
                    result = None
                    if self.auto_merge and prior[1] is not None and l["kind"]==r["kind"]=="text":
                        a = text_content(self.left.read(name,l))
                        b = text_content(self.right.read(name,r))
                        result = merged_text(prior[1],a,b)
                    if result is None:
                        report.append({"path":name,"status":"conflict","reason":"both modified or delete versus edit"})
                        continue
                    self.transfer(name,result.encode(),l,r)
                    report.append({"path":name,"status":"merged"})
                    continue
                data = source.read(name,chosen)
                self.transfer(name,data,l,r,chosen)
                report.append({"path":name,"status":"deleted" if data is None else "transferred"})
            except (OSError, Changed, subprocess.SubprocessError) as e:
                report.append({"path":name,"status":"retry","reason":str(e)})
        self.checkpoint("finish", len(names), len(names))
        cleanup=[]
        if time.time()-self.last_cleanup>=3600:
            protected=[r["path"] for r in report if r["status"] in ("retry","conflict","blocked","excluded")]
            protected+=list(pending)
            cleanup=[self.left.cleanup(protected,**self.retention),self.right.cleanup(protected,**self.retention)]
            self.last_cleanup=time.time()
        snapshot={"time":time.time(),"health":"ok","files":report,"cleanup":cleanup}
        temporary=self.state/"status.next"
        temporary.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
        os.replace(temporary,self.state/"status.json")
        self.checkpoint("idle", len(names), len(names))
        return report


def rpc_reply(req):
    try:
        endpoint=Endpoint(req["root"],req["recovery"],recover_on_start=req["action"]=="write")
        if req["action"]=="probe":
            result=endpoint.probe(req["name"],req["patterns"],req["limit"],req.get("presets"))
        elif req["action"]=="scan":
            result=endpoint.scan(req["patterns"],req["limit"],req.get("presets"))
        elif req["action"]=="cleanup":
            result=endpoint.cleanup(req["protected"],req["days"],req["max_bytes"],req["keep"])
        elif req["action"]=="read":
            value=endpoint.read(req["name"],req.get("expected"),req.get("maximum"))
            result=base64.b64encode(value).decode() if value is not None else None
        elif req["action"]=="write":
            data=base64.b64decode(req["data"]) if req["data"] is not None else None
            result=endpoint.write(req["name"],data,req["expected"],req["mode"])
        else:
            raise ValueError("Unknown action")
        return {"result": result}
    except Exception as error:
        return {"error": str(error)}


def main():
    # The host sends UTF-8 JSON even when Windows uses a legacy console locale.
    for stream in (sys.stdin,sys.stdout,sys.stderr):
        if hasattr(stream,"reconfigure"):stream.reconfigure(encoding="utf-8")
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=["once","watch","rpc","rpc-stream","ui"])
    parser.add_argument("--config")
    args=parser.parse_args()
    if args.command == "rpc":
        print(json.dumps(rpc_reply(json.load(sys.stdin))))
        return
    if args.command == "rpc-stream":
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            print(json.dumps(rpc_reply(json.loads(line))), flush=True)
        return
    if not args.config:parser.error("--config is required")
    config_path=Path(args.config)
    config=json.loads(config_path.read_text(encoding="utf-8"))
    def endpoint(spec):
        return SSH(**spec) if "host" in spec else Endpoint(**spec,recover_on_start=args.command!="ui")
    def create(current):
        if current.get("migration"):
            previous=current["migration"]
            database=Path(current["state"])/"state.sqlite"
            if database.exists():
                def binding(left,right):
                    return json.dumps([[str(Path(left["root"]).resolve()),str(Path(left["recovery"]).resolve())],
                                       [right["host"],right["root"],right["recovery"]]])
                old=binding(previous["left"],previous["right"])
                new=binding(current["left"],current["right"])
                with sqlite3.connect(database) as db:
                    row=db.execute("SELECT value FROM metadata WHERE key='endpoints'").fetchone()
                    if row and row[0] not in (old,new):raise ValueError("Migration binding mismatch")
                    db.execute("UPDATE metadata SET value=? WHERE key='endpoints'",(new,))
        if not 1<=current.get("max_bytes",104857600)<=1024**3:
            raise ValueError("Default size limit must be between 1 byte and 1 GiB")
        return Engine(endpoint(current["left"]),endpoint(current["right"]),current["state"],
                      current.get("ignores"),current.get("max_bytes",104857600),
                      current.get("auto_merge",False),current.get("settle_seconds",1),
                      current.get("retention"),current.get("presets"))
    if args.command=="ui":
        engine=None
        try:
            engine=create(config)
            request=json.load(sys.stdin)
            if request["action"]=="plan":result=engine.plan()
            elif request["action"]=="inspect":
                connection = engine.right.session() if isinstance(engine.right, SSH) else contextlib.nullcontext()
                with connection:
                    result = engine.inspect(request["path"], request.get("diffOffset", 0), request.get("diffOnly", False))
            elif request["action"]=="resolve-batch":result=engine.resolve_batch(request["items"])
            elif request["action"]=="resolve":result=engine.resolve(request["path"],request["side"],request["expected"])
            else:raise ValueError("Unknown UI action")
            print(json.dumps({"result":result},ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"error":str(e)},ensure_ascii=False))
        finally:
            if engine is not None:engine.close()
        return
    engine=create(config)
    stopped=threading.Event()
    if args.command=="watch":
        signal.signal(signal.SIGTERM,lambda *_:stopped.set())
        signal.signal(signal.SIGINT,lambda *_:stopped.set())
    failures=0
    log=logging.getLogger("dsh-sync")
    handler=RotatingFileHandler(engine.state/"events.log",maxBytes=2*1024*1024,backupCount=3,encoding="utf8")
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    def event(value):
        log.info(json.dumps(value,ensure_ascii=False))
        print(json.dumps(value),flush=True)
    try:
        with exclusive_lock(engine.state/"watch.lock"):
            running=engine.state/"running.json"
            running.write_text(json.dumps({"pid":os.getpid(),"started":time.time()}))
            while not stopped.is_set() and not (engine.state/"stop.request").exists():
                try:
                    fresh=json.loads(config_path.read_text(encoding="utf-8"))
                    if any(fresh[k]!=config[k] for k in ("left","right","state")):
                        raise Changed("Endpoint changes require a new configuration and explicit restart")
                    if fresh!=config:
                        replacement=create(fresh)
                        engine.close()
                        engine=replacement
                        config=fresh
                    engine.watch_mode = args.command == "watch"
                    rows=engine.cycle()
                    failures=0
                    counts={}
                    for row in rows:counts[row["status"]]=counts.get(row["status"],0)+1
                    event({"time":time.time(),"counts":counts})
                except PauseRequested:
                    break
                except (OSError,Changed,ValueError,subprocess.SubprocessError,sqlite3.Error) as e:
                    if args.command=="once":raise
                    failures+=1
                    status=engine.state/"status.json"
                    try:previous=json.loads(status.read_text())
                    except (OSError,ValueError):previous={}
                    previous.update({"health":"retrying","error":str(e),"error_time":time.time(),
                                     "retry_seconds":min(60,2**min(failures,6))})
                    temp=status.with_suffix(".next")
                    temp.write_text(json.dumps(previous,ensure_ascii=False))
                    os.replace(temp,status)
                    event({"time":time.time(),"error":str(e)})
                if args.command=="once":break
                delay = min(60, 2**min(failures, 6)) if failures else max(0.05, config.get("interval_seconds", 3))
                deadline = time.monotonic() + delay
                while not (engine.state/"stop.request").exists() and not stopped.is_set():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    stopped.wait(min(0.25, remaining))
    finally:
        try:
            running=engine.state/"running.json"
            if running.exists() and json.loads(running.read_text()).get("pid")==os.getpid():running.unlink()
        finally:
            engine.close()
            handler.close()


if __name__=="__main__":
    main()
