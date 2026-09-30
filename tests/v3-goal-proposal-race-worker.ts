import {parentPort,workerData} from 'node:worker_threads';
import {V1Database} from '../src/database.js';
import {V3GoalProposalHost} from '../src/v3-goal-proposal.js';

const data=workerData as {file:string;barrier:SharedArrayBuffer;proposal:unknown;envelope:unknown};
const view=new Int32Array(data.barrier);
parentPort!.postMessage({ready:true});
while(Atomics.load(view,0)===0) Atomics.wait(view,0,0,1000);
let database:V1Database|undefined;
try{database=new V1Database(data.file);const result=new V3GoalProposalHost(database).admit(data.proposal,data.envelope);parentPort!.postMessage({ok:true,result});}
catch(error){parentPort!.postMessage({ok:false,error:String(error)});}
finally{database?.db.close();}
