import assert from 'node:assert/strict';
import {filterToolResult,redactText} from '../local-tools.mjs';
import {workstationTools} from '../tool-routing.mjs';

const paths='C:\\outside\\a.txt\nMicrosoft.PowerShell.Core\\FileSystem::C:\\workspace\\b.txt\n/home/example/file.txt';
assert.equal(redactText(paths),paths);
const result=filterToolResult({content:[{type:'text',text:JSON.stringify({
 stdout:'192.0.2.17\n2001:db8::1\nAustralia/Sydney\nAUS Eastern Standard Time',
 path:'C:\\outside\\a.txt',exit_code:0,
})}]});
const value=JSON.parse(result.content[0].text);
assert.doesNotMatch(value.stdout,/192\.0\.2|2001:db8|Australia\/Sydney|Eastern Standard/);
assert.equal(value.path,'C:\\outside\\a.txt');
assert.equal(value.exit_code,0);
assert.equal(filterToolResult({content:[{type:'text',text:'ok'}]}).content[0].text,'ok');

assert.equal(value.stdout,'\n\n\n');
assert.equal(redactText('address=192.0.2.17; done'),'address=; done');
for(const text of [
 String.raw`C:\project\UTC\readme.md`,
 String.raw`C:\cache\192.0.2.17\data.json`,
 '/home/Asia/Shanghai/project/file.txt',
 'Assets/UTC/file.cs',
 'cache/192.0.2.17/data.json',
 'version 1.2.3.4',
 'ClientVersion = "2.3.4.5"',
 'v3.4.5.6',
 'invalid address 999.123.456.789',
]){
 assert.equal(redactText(text),text);
}
const json='{ "UTC":"first", "GMT":"second", "ip":"192.0.2.17", "number":9007199254740993, "version":["1.2.3.4","2.3.4.5"] }';
assert.equal(filterToolResult({content:[{type:'text',text:json}]}).content[0].text,
 json.replace('"192.0.2.17"',''+'""'));
const untouched='{ "UTC": true, "GMT": false, "value": null, "number": 9007199254740993 }';
assert.equal(filterToolResult({content:[{type:'text',text:untouched}]}).content[0].text,untouched);
assert.equal(redactText('192.\x1b[31m0.2.17\x1b[0m'),'');
assert.equal(redactText('http://192.0.2.17/status'),'http:///status');
assert.equal(redactText('BaseUtcOffset : 11:00:00'),'BaseUtcOffset : ');
const definitions=[{name:'Read'},{name:'EnterWorktree'},{name:'FutureFileTool'},{name:'Agent'},{name:'CronCreate'},{name:'WebSearch'},{name:'TaskStop'}];
assert.deepEqual(workstationTools(definitions),[definitions[0],definitions[1],definitions[2],definitions[6]]);
