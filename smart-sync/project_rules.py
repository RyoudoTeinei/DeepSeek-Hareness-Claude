"""Project policy resolution: Git handles Git syntax, EditorConfig handles EOL."""
import configparser
import fnmatch
import hashlib
import os
from pathlib import Path
import re
import subprocess

BINARY_EXTENSIONS={".pdf",".png",".jpg",".jpeg",".gif",".webp",".ico",".woff",".woff2",
                   ".sqlite",".db",".exe",".dll",".so",".bin",".zip",".gz"}
RULE_NAMES={".gitattributes",".gitignore",".editorconfig"}


def glob_match(name, pattern):
    # EditorConfig braces support alternatives and numeric ranges.
    match=re.search(r"\{([^{}]+)\}",pattern)
    if match:
        value=match.group(1)
        bounds=re.fullmatch(r"(-?\d+)\.\.(-?\d+)",value)
        if bounds:
            a,b=map(int,bounds.groups())
            if b<a or b-a>1000:raise ValueError("Unsupported EditorConfig numeric range")
            choices=map(str,range(a,b+1))
        else:choices=value.split(",")
        return any(glob_match(name,pattern[:match.start()]+c+pattern[match.end():]) for c in choices)
    pattern=pattern.lstrip("/")
    if "/" not in pattern:name=name.rsplit("/",1)[-1]
    # * is confined to a path component, ** spans components.
    expr=""
    i=0
    while i<len(pattern):
        c=pattern[i]
        if pattern[i:i+3]=="**/":expr+="(?:.*/)?";i+=3;continue
        if pattern[i:i+2]=="**":expr+=".*";i+=2;continue
        if c=="*":expr+="[^/]*"
        elif c=="?":expr+="[^/]"
        elif c=="[":
            j=pattern.find("]",i+1)
            if j<0:expr+=r"\["
            else:
                group=pattern[i+1:j]
                if group.startswith("!"):group="^"+group[1:]
                expr+="["+group+"]";i=j
        else:expr+=re.escape(c)
        i+=1
    return re.fullmatch(expr,name) is not None


class ProjectRules:
    def __init__(self,root,state):
        self.root=Path(root)
        self.repo=Path(state)/"rules.git"
        if not self.repo.exists():
            self.run(["init","--bare",str(self.repo)],repository=False)
        self.editor_cache={}

    def run(self,args,data=None,repository=True):
        command=["git"]
        if repository:
            command+=["-c","core.bare=false","-c","core.excludesFile="+os.devnull,
                      "-c","core.attributesFile="+os.devnull,"--git-dir",str(self.repo),
                      "--work-tree",str(self.root)]
        result=subprocess.run(command+args,input=data,capture_output=True,timeout=30)
        if result.returncode not in (0,1):raise OSError(result.stderr.decode(errors="replace"))
        return result.stdout

    def editor(self,name):
        parts=Path(name).parts
        values={}
        for depth in range(len(parts)):
            parent=self.root.joinpath(*parts[:depth])
            path=parent/".editorconfig"
            if not path.exists():continue
            if path.is_symlink():raise ValueError("EditorConfig symbolic link is unsupported")
            if path not in self.editor_cache:
                text=path.read_text(encoding="utf-8-sig")
                parser=configparser.RawConfigParser(strict=False,interpolation=None)
                parser.optionxform=str.lower
                parser.read_string("[__root__]\n"+text)
                self.editor_cache[path]=parser
            parser=self.editor_cache[path]
            if parser.get("__root__","root",fallback="false").lower()=="true":values={}
            relative="/".join(parts[depth:])
            for section in parser.sections():
                if section!="__root__" and glob_match(relative,section):
                    values.update({k:v.lower() for k,v in parser.items(section)})
        return {k:v for k,v in values.items() if v!="unset"}

    def resolve(self,names):
        if not names:return {}
        payload=b"".join(n.encode()+b"\0" for n in names)
        ignored=set(self.run(["check-ignore","--no-index","-z","--stdin"],payload).decode().strip("\0").split("\0"))
        output=self.run(["check-attr","-z","--stdin","text","eol","filter","working-tree-encoding"],payload).decode().split("\0")
        attrs={}
        for i in range(0,len(output)-2,3):attrs.setdefault(output[i],{})[output[i+1]]=output[i+2]
        policies={}
        for name in names:
            attr=attrs.get(name,{})
            editor=self.editor(name)
            eol=attr.get("eol")
            if eol not in ("lf","crlf"):eol=editor.get("end_of_line","preserve")
            encoding=attr.get("working-tree-encoding")
            if encoding in (None,"unspecified","unset"):encoding=editor.get("charset","utf-8")
            binary=attr.get("text")=="unset" or Path(name).suffix.lower() in BINARY_EXTENSIONS
            if attr.get("text")=="set":binary=False
            problem=None
            if eol not in ("lf","crlf","preserve"):problem="Unsupported end_of_line: "+eol
            if encoding.lower() not in ("utf-8","utf-8-bom"):binary=True
            policies[name]={"ignore":name in ignored or attr.get("filter")=="lfs",
                            "binary":binary,"eol":eol,"problem":problem}
        return policies

DEFAULT_PRESETS=[
    {"name":"代码和文档","extensions":[".py",".js",".ts",".tsx",".jsx",".md",".txt",".json",".yaml",".yml",".toml",".sh",".bat",".cmd"],"enabled":True,"max_mib":10},
    {"name":"图片和 PDF","extensions":[".png",".jpg",".jpeg",".webp",".gif",".pdf"],"enabled":True,"max_mib":25},
    {"name":"模型权重","extensions":[".pt",".pth",".ckpt",".safetensors",".gguf"],"enabled":False,"max_mib":100},
    {"name":"视频","extensions":[".mp4",".mov",".mkv",".avi",".webm"],"enabled":False,"max_mib":100},
    {"name":"压缩包","extensions":[".zip",".tar",".tar.gz",".gz",".7z"],"enabled":False,"max_mib":100},
]


def validate_presets(presets):
    if not isinstance(presets,list) or len(presets)>100:raise ValueError("Invalid preset list")
    for row in presets:
        if not isinstance(row.get("name"),str) or not row["name"]:raise ValueError("Preset name required")
        if not isinstance(row.get("enabled"),bool):raise ValueError("Preset enabled must be boolean")
        value=row.get("max_mib")
        if type(value) not in (int,float) or not 0<value<=1024:raise ValueError("Preset size must be 0–1024 MiB")
        if not isinstance(row.get("extensions"),list):raise ValueError("Extensions must be a list")
        for suffix in row["extensions"]:
            if not isinstance(suffix,str) or not suffix.startswith(".") or any(c in suffix for c in "/\\*?[]"):
                raise ValueError("Use literal suffixes such as .py or .tar.gz")
    return presets


def extension_policy(name,presets,limit):
    selected=None
    length=0
    for row in validate_presets(presets):
        for suffix in row["extensions"]:
            if name.lower().endswith(suffix.lower()) and len(suffix)>=length:
                selected=row
                length=len(suffix)
    if selected is None:return {"preset":"其他文件","enabled":True,"limit":limit}
    return {"preset":selected["name"],"enabled":selected["enabled"],"limit":int(selected["max_mib"]*1048576)}
