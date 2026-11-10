// Conversation, inference, and web operations stay in the VPS session.
// Everything else from the workstation's native catalog is forwarded as-is.
export const serverTools=[
 'Agent','AskUserQuestion','EnterPlanMode','ExitPlanMode',
 'TaskCreate','TaskGet','TaskList','TaskUpdate','TaskOutput','TaskStop',
 'WebSearch','WebFetch','Skill','ToolSearch','SendMessage','ListAgents',
 'Workflow','CronCreate','CronDelete','CronList','ScheduleWakeup','Monitor',
 'PushNotification','ReportFindings','SendFeedback',
];

export function workstationTools(tools){
 return tools.filter(tool=>!serverTools.includes(tool.name)||tool.name==='TaskStop');
}
