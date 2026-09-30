import {parentPort,workerData} from 'node:worker_threads';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';

let db:V1Database|undefined;
try{
 db=new V1Database(workerData.file);const queue=new V2QueueService(db);
 parentPort!.postMessage({ready:true});
 const view=new Int32Array(workerData.barrier);while(Atomics.load(view,0)===0)Atomics.wait(view,0,0,1000);
 if(workerData.mode==='enqueue'){
  const result=queue.enqueueInbound({accountId:'demo-account',conversationId:'conv-001',externalMessageId:workerData.externalMessageId,messageId:workerData.messageId,occurredAt:'2026-09-10T00:00:00Z',text:'race'});
  parentPort!.postMessage({ok:true,result:{arrivalSeq:result.arrivalSeq,deduplicated:result.deduplicated}});
 }else{
  const lease=queue.claimNext({accountId:'demo-account',conversationId:'conv-001',owner:workerData.owner,nowIso:'2026-09-10T00:00:00Z'});parentPort!.postMessage({ok:true,lease:lease&&{token:lease.leaseToken,owner:lease.leaseOwner,arrivalSeq:lease.arrivalSeq}})
 }
}catch(error){parentPort!.postMessage({ok:false,error:String(error)})}finally{db?.db.close()}
