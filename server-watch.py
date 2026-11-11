"""Read-only SSH terminal view of one structured Claude session's real events."""
import json
import os
from pathlib import Path
import re
import select
import sys
import time


def safe_text(value, limit=None):
    text=str(value)
    text=re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f]', '', text)
    if limit is not None and len(text)>limit:
        return text[:limit]+'\n[显示已截断，完整事件保存在本会话日志中]'
    return text


class EventView:
    def __init__(self):
        self.message=''
        self.texts={}
        self.tools={}
        self.controls={}
        self.last_text=''

    def render(self, record):
        kind=record.get('type')
        if kind=='stderr':
            return '\n[服务器 stderr] '+safe_text(record.get('text',''),4000)+'\n'
        if kind=='broker_error':
            return '\n[任务错误] '+safe_text(record.get('message',''))+'\n'
        if kind=='approval_result':
            tool=self.controls.get(record.get('request_id'),'操作')
            return '\n[审批 '+('允许' if record.get('behavior')=='allow' else '拒绝')+'] '+safe_text(tool)+'\n'
        if kind=='artifact_ready':
            artifact=record.get('artifact',{})
            return '\n[成果已发布] '+safe_text(artifact.get('name',''))+' · '+str(artifact.get('size',0))+' 字节\n'
        if kind=='broker_done':
            return '\n[本轮结束] '+('已停止' if record.get('cancelled') else '等待下一条消息')+'\n'
        if kind!='claude_event':
            return ''
        event=record.get('event',{})
        if event.get('parent_tool_use_id'):
            return ''
        kind=event.get('type')
        if kind=='system' and event.get('subtype')=='init':
            return '\n[Claude 会话] '+safe_text(event.get('session_id',''))+'\n[模型] '+safe_text(event.get('model','服务器默认'))+'\n'
        if kind=='control_request':
            request=event.get('request',{})
            tool=request.get('tool_name',request.get('subtype','操作'))
            self.controls[event.get('request_id')]=tool
            return '\n[等待 DSH 审批] '+safe_text(tool)+'\n'
        if kind=='stream_event':
            part=event.get('event',{})
            if part.get('type')=='message_start':
                self.message=part.get('message',{}).get('id','')
                self.last_text=''
            key=(self.message,part.get('index'))
            if part.get('type')=='content_block_start' and part.get('content_block',{}).get('type')=='thinking':
                return '\n[Claude 正在处理]\n'
            text=''
            if part.get('type')=='content_block_start' and part.get('content_block',{}).get('type')=='text':
                text=part['content_block'].get('text','')
            if part.get('type')=='content_block_delta' and part.get('delta',{}).get('type')=='text_delta':
                text=part['delta'].get('text','')
            if text:
                self.texts[key]=self.texts.get(key,'')+text
                self.last_text+=text
                return safe_text(text)
            if part.get('type')=='content_block_stop' and key in self.texts:
                return '\n'
            return ''
        if kind=='assistant':
            message=event.get('message',{})
            output=[]
            complete=[]
            for index,block in enumerate(message.get('content',[])):
                if block.get('type')=='text':
                    text=block.get('text','');complete.append(text)
                    key=(message.get('id',self.message),index)
                    prior=self.texts.get(key,'')
                    if text.startswith(prior):
                        output.append(safe_text(text[len(prior):]))
                    self.texts[key]=text
                elif block.get('type')=='tool_use' and block.get('id') not in self.tools:
                    self.tools[block['id']]=block.get('name','tool')
                    output.append('\n[执行 '+safe_text(block.get('name','tool'))+']\n'+safe_text(json.dumps(block.get('input',{}),ensure_ascii=False,indent=2),6000)+'\n')
            if complete:self.last_text=''.join(complete)
            return ''.join(output)
        if kind=='user' and isinstance(event.get('message',{}).get('content'),list):
            output=[]
            for block in event['message']['content']:
                if block.get('type')!='tool_result':continue
                content=block.get('content','')
                if isinstance(content,list):
                    content='\n'.join(item.get('text','[非文本结果]') for item in content if isinstance(item,dict))
                output.append('\n['+('失败 ' if block.get('is_error') else '完成 ')+safe_text(self.tools.get(block.get('tool_use_id'),'tool'))+']\n'+safe_text(content,6000)+'\n')
            return ''.join(output)
        if kind=='result':
            text=event.get('result','')
            output=''
            if text and text.strip()!=self.last_text.strip():output=safe_text(text)+'\n'
            return output+'\n[Claude '+('失败' if event.get('is_error') else '完成')+']\n'
        return ''


def current_turn(directory):
    try:
        value=json.loads((directory/'current-turn.json').read_text())
        if re.fullmatch(r'[a-f0-9]{32}',value.get('turn','')):return value
    except (OSError,ValueError):pass
    requests=list((directory/'turns').glob('*/request.json'))
    if not requests:return None
    latest=max(requests,key=lambda file:file.stat().st_mtime)
    if not re.fullmatch(r'[a-f0-9]{32}',latest.parent.name):return None
    return {'turn':latest.parent.name,'status':'历史记录'}


def read_events(file, offset):
    records=[]
    try:
        with file.open('rb') as stream:
            stream.seek(offset)
            for line in stream:
                if not line.endswith(b'\n'):break
                offset+=len(line)
                try:records.append(json.loads(line))
                except ValueError:continue
    except FileNotFoundError:pass
    return records,offset


def watch(directory, once=False):
    print('DSH · 服务器运行窗口',flush=True)
    print('读取当前聊天的服务器事件日志。审批和发送消息在 DSH 完成；Ctrl+C 关闭此视图。',flush=True)
    selected=None;offset=0;view=EventView();status=None
    while True:
        current=current_turn(directory)
        if current:
            if current['turn']!=selected:
                selected=current['turn'];offset=0;view=EventView();status=None
                print('\n'+'─'*48+'\n[轮次] '+selected,flush=True)
            next_status=(current.get('status'),current.get('pid'))
            if next_status!=status:
                status=next_status
                print('[服务器状态] '+safe_text(current.get('status','未知'))+((' · PID '+str(current['pid'])) if current.get('pid') else ''),flush=True)
            records,offset=read_events(directory/'turns'/selected/'events.jsonl',offset)
            for record in records:
                text=view.render(record)
                if text:print(text,end='',flush=True)
        elif status!='waiting':
            print('[等待] 此聊天尚无服务器任务。可在左侧直接发送消息。',flush=True);status='waiting'
        if once:return
        if not sys.stdin.isatty() and select.select([sys.stdin],[],[],0)[0]:
            if not os.read(sys.stdin.fileno(),1024):return
        time.sleep(.25)


if __name__=='__main__':
    try:
        scope=sys.argv[1]
        if not re.fullmatch(r'[a-f0-9]{32}',scope):raise ValueError('Invalid scope')
        directory=Path(__file__).resolve().parent/'sessions'/scope
        watch(directory,'--once' in sys.argv[2:])
    except (KeyboardInterrupt,BrokenPipeError):pass
