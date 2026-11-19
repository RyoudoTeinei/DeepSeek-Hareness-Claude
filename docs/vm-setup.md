# 本地执行虚拟机准备

本分支保存的是插件与部署脚本。已验证的环境是 Windows、Node.js 22、宿主 Python 3.14（含 Paramiko）、QEMU/WHPX、Debian 13 和 Linux Claude Code 2.1.322。通用一键安装尚未提供；不要直接在现有个人开发虚拟机上运行这些初始化脚本。

## 目录与依赖

将 `scripts/vm/` 的脚本复制到独立运行目录，例如 `C:\DSHVM`。运行目录不要放进需要共享给 Claude 的项目中；当前启动脚本要求磁盘等运行路径不含空格，项目路径可以有空格。

```text
C:\DSHVM\
  create-vm.py
  start-vm.ps1
  control-vm.py
  install-native-cc.py
  install-session-sandbox.py
  cage-runtime\           # 兼容 WHPX 的 QEMU 运行时
  downloads\              # 自行下载并校验的公开发行文件
  instance\               # 由脚本生成；包含磁盘、密钥和本机配置
```

需要预先启用 Windows Hypervisor Platform 和硬件虚拟化。脚本不会替你修改 Windows 功能、系统代理或网卡。`cage-runtime/` 中应有一份可用的 `qemu-system-x86_64.exe` 与配套 `qemu-img.exe`、DLL 和固件；它只是运行时目录名，不要求安装或登录 Cage 应用。

宿主 Python 需安装 `paramiko`。准备以下文件到 `downloads/`：

| 文件 | 来源及校验 |
| --- | --- |
| `debian-13-generic-amd64.qcow2` | [Debian 官方 cloud 镜像](https://cloud.debian.org/images/cloud/trixie/latest/)，下载并核对同目录 SHA512SUMS |
| `pycdlib-1.14.0-py2.py3-none-any.whl` | [PyPI pycdlib](https://pypi.org/project/pycdlib/1.14.0/)，核对发行文件摘要 |
| `claude-2.1.322-linux-x64.zst` | `https://downloads.claude.ai/claude-code-releases/2.1.322/linux-x64/claude.zst` |
| `claude-2.1.322-manifest.json` | 同一官方发行目录下的 `manifest.json` |
| `claude-2.1.322-manifest.zst.json` | 同一官方发行目录下的 `manifest.zst.json` |
| `bubblewrap_0.12.0_amd64.deb` | [Debian bubblewrap 下载页](https://packages.debian.org/trixie/amd64/bubblewrap/download)，脚本固定校验 `0.12.0-1~deb13u1` 的 SHA-256 |

CC 安装脚本会同时校验压缩包和解压后的二进制，并再次校验复制到客机的文件；Bubblewrap 脚本也会校验包摘要。这里不分发这些二进制或镜像。

## 初始化

1. 在独立运行目录执行 `python create-vm.py --plugin-root "插件代码检出路径"`。脚本生成新的实例 UUID、SSH 密钥、固定主机指纹、cloud-init 种子和 12 GiB 稀疏覆盖磁盘；默认分配 2 GiB 内存、2 vCPU。已有 `instance/vm.json` 时拒绝覆盖。
2. 首次执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\start-vm.ps1 -Network bootstrap`，让 cloud-init 安装 `sshfs` 和 Python。等待 `instance/boot.log` 出现 `DSH_EXECUTOR_BOOTSTRAP_COMPLETE`。这一阶段不要接入云端工具。
3. 执行 `python control-vm.py powerdown` 并等待 QEMU 真正退出，再以 `-Network isolated` 启动。这个手动辅助命令只报告关机请求；插件界面的电源控制会等待实际关机并检查活动会话。
4. 运行 `python install-native-cc.py` 和 `python install-session-sandbox.py`。两者仅安装到专用客机的 `dshvm` 用户目录；不运行 Windows 版 CC，也不导入本机 Claude 配置。
5. 不在客机登录 Claude。仅 VPS 上的 CC 使用服务器已有的认证；客机 CC 通过 `claude mcp serve` 提供工具。

覆盖磁盘依赖原始 Debian 基础镜像。**不要移动或删除正在使用的基础镜像、覆盖磁盘、种子或密钥。** `instance/`、`downloads/` 和 `cage-runtime/` 已加入忽略规则，但仍应保存在独立运行目录。

## 注册到 DSH

在 `%LOCALAPPDATA%\DSH-Remote-Claude\vm-executor.json` 写入本机配置。下例仅说明格式；必须用生成的 `instance/vm.json` 中的实际 UUID、端口和文件路径替换占位值：

```json
{
  "guest": {
    "host": "127.0.0.1",
    "port": 22222,
    "user": "dshvm",
    "identity": "C:\\DSHVM\\instance\\user_key",
    "knownHosts": "C:\\DSHVM\\instance\\known_hosts",
    "instanceId": "11111111-1111-4111-8111-111111111111"
  },
  "hostPython": "C:\\Python314\\python.exe",
  "vmStatePath": "C:\\DSHVM\\instance\\vm.json",
  "startScript": "C:\\DSHVM\\start-vm.ps1"
}
```

注册文件不属于项目代码，不应提交到 GitHub。重启 DSH 后，工作台会读取执行器状态。初始化完成后使用工作台「启动虚拟机」「关闭虚拟机」或「接入 Claude」，电源策略会保留手动关闭状态；不要继续用 bootstrap 模式启动日常任务。

## 会话边界

- 每个聊天有自己的挂载点、CC MCP 进程、配置、临时目录及任务记录；Bubblewrap 只暴露该会话的项目与私有状态，隔离不可用时拒绝启动。
- 不同项目互相隔离；同项目聊天共享原文件夹，同时修改同一文件可能冲突。
- Windows 用户目录、Claude 配置、AppData、SSH 等不能作为共享根目录。共享项目自身的文件仍可读，包括其中的 `.claude`、日志或身份信息；读取结果会进入云端会话。
- 客机公网网络关闭，额外项目依赖需要单独准备。Skill 在云端加载，其脚本和依赖不会自动出现在客机。
- 正常关机保留磁盘与聊天记录，正在执行的命令会中断。不要将电源管理理解为任务断点续跑。
