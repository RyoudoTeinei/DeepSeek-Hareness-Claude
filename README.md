# DeepSeek Hareness Claude

Windows 版 DeepSeek Harness 的远程 Claude Code 工作区插件。在本地选择项目，通过 SSH 连接自己的 Linux 服务器，在 DSH 内使用 Claude 原生终端、服务器 Shell 和文件同步面板。

## 使用

1. 本地安装 Node.js、Git 和 Windows OpenSSH。远端需能通过 SSH 登录，并已安装 Git、tmux、Python 3 和 Claude Code。
2. 在 DSH 插件管理器添加此 GitHub 仓库，启用插件。在左侧点击「＋ 添加 Claude 工作区」，选择本地文件夹并填写 SSH 主机、远程项目名。默认使用桌面 profile 的 ~/.dsh/profiles/desktop；其他 profile 需调整 client.js 中的插件路径。
3. 点击「接入 Claude」或「服务器 Terminal」。同一个 SSH 用户、主机和工作区可重新接回仍在运行的 tmux 会话。重新接入会取得交互控制权并断开同一会话的旧终端连接，远端进程和对话继续保留；终端启用鼠标支持。
4. 在「文件同步」中筛选、全选或勾选文件，填写说明并确认推送。Git 将当前分支已有提交和本次所选文件提交直接推到远端同名分支。远端已有的未跟踪输出文件不会阻止无关文件的推送；已跟踪文件的未提交改动和会被覆盖的同名文件仍会阻止推送。拉取使用快进合并。面板显示本地提交阶段、已用时间和 Git 上传进度。
5. 若需要自动回传未提交的文件，请从 [Mutagen 官方发布页](https://github.com/mutagen-io/mutagen/releases/tag/v0.18.1) 安装 Windows 版本，将 mutagen.exe 加入 PATH，保留配套的 mutagen-agents.tar.gz，重启 DSH。随后按项目启用「自动回传服务器文件」。使用系统 SSH 配置或 SSH 别名。远程文件创建、修改和删除会传播到本地，冲突保留供处理，关闭面板后同步继续。首次启用前请核对两端路径。
6. 工作台支持将剪贴板图片经 SSH 上传至自己的服务器，插入远程路径后手动确认发送。

## 版本 0.3.0

- 点「接入 Claude」后，在左侧模型选择器选「Claude Code · 远程工作区」即可发送文字、查看回复。右侧终端保留同一个 Claude 会话，可在里面使用斜杠命令、处理权限提示和图片。
- 在 Claude 工作区左下角点击「Claude 额度」，首次使用点「启用额度显示」。插件通过 SSH 读取远程 Claude Code 状态栏记录的 5 小时和每周剩余额度。面板显示本地时区的重置时间及上次更新时间。已有自定义状态栏时，启用操作会停止并提示。

## 版本 0.2.2

新增嵌入式 Git 同步、按文件选择、进度显示和基于 Mutagen 的远程文件回传。在 Windows DSH 和 Linux VPS 上验证过终端接入、测试仓库提交推送、未提交文件回传和冲突保留。

## 开发验证

本地安装 Node.js、Git 和 Python 3.8 或更新版本后，运行 `npm test`。测试使用标准库和临时 Git 仓库，覆盖多块 Claude 回复的完整读取，以及推送时对服务器文件的保护。
