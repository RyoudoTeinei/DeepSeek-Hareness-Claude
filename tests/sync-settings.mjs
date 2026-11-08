import assert from 'node:assert/strict';
import {syncOptions, describeSession} from '../return-files.mjs';
assert.equal(syncOptions().maxFileMiB,100);
assert.throws(()=>syncOptions({maxFileMiB:0}));
assert.throws(()=>syncOptions({maxFileMiB:1.5}));
assert.throws(()=>syncOptions({ignores:['line\nbreak']}));
assert.throws(()=>syncOptions({ignores:['a,b']}));
assert.deepEqual(syncOptions({maxFileMiB:10,ignores:['*.pt','*.pt']}).ignores,['*.pt']);
const state=describeSession({mode:'two-way-safe',maxStagingFileSize:1048576,paused:false,
 conflicts:[{root:'a.txt'}],excludedConflicts:5,
 alpha:{connected:true,scanProblems:[{path:'dir',error:'permission denied'}]},
 beta:{connected:true,transitionProblems:[{path:'file',error:'write failed'}]},
 lastError:'size limit exceeded',ignore:{paths:['*.pt']}});
assert.equal(state.conflicts,6);
assert.equal(state.problems.length,3);
assert.equal(state.options.maxFileMiB,1);
assert.deepEqual(state.conflictPaths,['a.txt']);
assert.equal(describeSession({mode:'one-way-safe'}).options.maxFileMiB,100);
console.log('Synchronization settings and state checks passed');
