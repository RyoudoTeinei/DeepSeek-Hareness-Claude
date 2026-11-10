import {isIP} from 'node:net';
import {stripVTControlCharacters} from 'node:util';

const zones=/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Brazil|Canada|Chile|Etc|Europe|Indian|Mexico|Pacific|US)\/[\w/+\-]+|\b(?:[A-Za-z]+[ -]){0,6}(?:Standard|Daylight|Summer) Time\b|\b(?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?\b|\b(?:AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|EET|EEST|JST|KST|HKT|SGT)\b|[+-]\d\d:\d\d\b|(?<=\d[T ]\d\d:\d\d:\d\d)[+-]\d{4}\b/g;

function protectedRanges(text){
 const ranges=[];
 const patterns=[
  /(["'\x60])(?:[a-z]:[\\/]|\\\\|\/)[^\r\n]*?\1/gi,
  /(?<![\w:/\\])(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\s"'\x60<>|]*/gi,
  /[^\s"'\x60<>|]*\\[^\s"'\x60<>|]+/g,
 ];
 for(const pattern of patterns)
  for(const match of text.matchAll(pattern))ranges.push([match.index,match.index+match[0].length]);
 for(const match of text.matchAll(/(?<![\w./:])[\w.@-]+\/[^\s"'\x60<>|]+/g)){
  if(!isIP(match[0].split('/')[0])&&!/^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Brazil|Canada|Chile|Etc|Europe|Indian|Mexico|Pacific|US)\//.test(match[0]))
   ranges.push([match.index,match.index+match[0].length]);
 }
 const versions=/\b[\w.-]*version[\w.-]*["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)+[\w.+-]*)|\bv(\d+(?:\.\d+)+[\w.+-]*)/gi;
 for(const match of text.matchAll(versions)){
  const value=match[1]||match[2],offset=match.index+match[0].lastIndexOf(value);
  ranges.push([offset,offset+value.length]);
 }
 ranges.sort((a,b)=>a[0]-b[0]);
 const merged=[];
 for(const range of ranges){
  const last=merged.at(-1);
  if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);
  else merged.push([...range]);
 }
 return merged;
}

export function redactText(text){
 text=stripVTControlCharacters(text);
 const ranges=protectedRanges(text);
 function covered(start,end){
  let left=0,right=ranges.length;
  while(left<right){
   const middle=(left+right)>>>1;
   if(ranges[middle][1]<=start)left=middle+1;
   else right=middle;
  }
  return left<ranges.length&&ranges[left][0]<end;
 }
 const removals=[];
 for(const match of text.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)){
  if(isIP(match[0])===4&&!covered(match.index,match.index+match[0].length))
   removals.push([match.index,match.index+match[0].length]);
 }
 for(const match of text.matchAll(/[\da-f:.]+/gi)){
  if(!match[0].includes(':')||match[0].length>80)continue;
  let value=match[0].replace(/^\.+|\.+$/g,'');
  if(value.startsWith(':')&&!value.startsWith('::'))value=value.slice(1);
  const start=match.index+match[0].indexOf(value),end=start+value.length;
  if(isIP(value)===6&&!covered(start,end))removals.push([start,end]);
 }
 for(const match of text.matchAll(zones)){
  const end=match.index+match[0].length;
  if(!covered(match.index,end))removals.push([match.index,end]);
 }
 for(const match of text.matchAll(/^[ \t]*[+-](?:0\d|1[0-4])[0-5]\d[ \t]*$/gm))
  removals.push([match.index,match.index+match[0].length]);
 for(const match of text.matchAll(/^([ \t]*(?:BaseUtcOffset|UtcOffset|TimeZone(?:Id|Name)?)[ \t]*[:=][ \t]*)([^\r\n]*)/gmi))
  removals.push([match.index+match[1].length,match.index+match[0].length]);
 removals.sort((a,b)=>a[0]-b[0]);
 let result='',cursor=0;
 for(const [start,end] of removals){
  if(start>=cursor)result+=text.slice(cursor,start);
  cursor=Math.max(cursor,end);
 }
 return result+text.slice(cursor);
}

function redactString(text,key=''){
 if(/(?:path|directory|filename)s?$/i.test(key))return text;
 if(/version/i.test(key)&&/^v?\d+(?:\.\d+)+[\w.+-]*$/i.test(text))return text;
 if(/^(?:BaseUtcOffset|UtcOffset|TimeZone(?:Id|Name)?)$/i.test(key))return '';
 try{
  JSON.parse(text);
 }catch{return redactText(text)}
 let cursor=0;
 const changes=[];
 function whitespace(){while(cursor<text.length&&/\s/.test(text[cursor]))cursor++}
 function string(){
  const start=cursor++;
  while(text[cursor]!=='"'){if(text[cursor]==='\\')cursor++;cursor++}
  cursor++;
  return {start,end:cursor,value:JSON.parse(text.slice(start,cursor))};
 }
 function visit(name){
  whitespace();
  if(text[cursor]==='{'){
   cursor++;whitespace();
   while(text[cursor]!=='}'){
    const property=string().value;
    whitespace();cursor++;
    visit(property);whitespace();
    if(text[cursor]===','){cursor++;whitespace()}
   }
   cursor++;
  }else if(text[cursor]==='['){
   cursor++;whitespace();
   while(text[cursor]!==']'){
    visit(name);whitespace();
    if(text[cursor]===',')cursor++;
   }
   cursor++;
  }else if(text[cursor]==='"'){
   const token=string();
   const filtered=redactString(token.value,name);
   if(filtered!==token.value)changes.push({...token,text:JSON.stringify(filtered)});
  }else{
   while(cursor<text.length&&!/[\s,\]}]/.test(text[cursor]))cursor++;
  }
 }
 visit(key);
 let result='',offset=0;
 for(const change of changes){result+=text.slice(offset,change.start)+change.text;offset=change.end}
 return result+text.slice(offset);
}

export function redactValue(value,key=''){
 if(typeof value==='string')return redactString(value,key);
 if(Array.isArray(value))return value.map(item=>redactValue(item,key));
 if(value&&typeof value==='object')
  return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,redactValue(item,name)]));
 return value;
}

export function filterToolResult(result){
 const filtered={...result};
 if(result.content)filtered.content=result.content.map(block=>
  block.type==='text'?{...block,text:redactString(block.text)}:block);
 if(result.structuredContent)filtered.structuredContent=redactValue(result.structuredContent);
 return filtered;
}
