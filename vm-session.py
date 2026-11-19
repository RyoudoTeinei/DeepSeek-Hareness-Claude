"""Choose a VM terminal without taking over a legacy server-only conversation."""
import re


def choose_terminal(scope, capabilities, binding, exists):
    if not re.fullmatch('[a-f0-9]{32}',scope):raise ValueError('Invalid session scope')
    fresh='dsh-vm-native-'+scope
    legacy='dsh-native-'+scope
    proven=capabilities.get('vmTools') is True and capabilities.get('vmEngine')=='claude-mcp-v2' and binding.get('vmEngine')=='claude-mcp-v2'
    if proven:
        selected=binding.get('terminal') or capabilities.get('terminal') or legacy
        if selected not in (fresh,legacy):raise ValueError('VM terminal binding mismatch')
        return selected
    if exists(fresh):raise ValueError('虚拟机会话身份记录不匹配；已有终端已保留，请检查会话绑定。')
    # A legacy session with the same DSH scope is a different execution mode.
    return fresh
