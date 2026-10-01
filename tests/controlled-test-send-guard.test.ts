import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {ControlledTestSendGuard,type ControlledTestSendPolicy} from '../src/controlled-test-send-guard.js';
import {createApp} from '../src/app.js';
import {SimulatedChannel} from '../src/channels.js';
const policy:ControlledTestSendPolicy={policyId:'synthetic-run',accountId:'synthetic-account',canonicalConversationId:'synthetic-conversation',recipient:'synthetic-peer'};
const wire=(id='synthetic-message')=>({accountId:policy.accountId,conversationId:policy.recipient,clientMessageId:id,text:'Synthetic guarded response'});
const submitted=()=>({status:'submitted' as const,externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()});
function setup(file=':memory:'){const db=new V1Database(file);db.resetAndSeed();conversation(db);return db}
function conversation(db:V1Database){db.db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?,?)').run(policy.canonicalConversationId,policy.accountId,policy.recipient,null,'OPEN',new Date().toISOString())}
const used=(db:V1Database)=>(db.db.prepare('SELECT used_attempts FROM controlled_test_send_budgets WHERE policy_id=?').get(policy.policyId) as any)?.used_attempts??0;

test('missing policy, wrong account/recipient/conversation fail closed without provider or budget mutation',async()=>{
 const db=setup();let calls=0;const send=async()=>{calls++;return submitted()};try{
 await assert.rejects(new ControlledTestSendGuard(db,undefined,send).send(wire()),/POLICY_REQUIRED/);
 const guard=new ControlledTestSendGuard(db,policy,send);
 for(const change of [{accountId:'other-account'},{conversationId:'other-peer'}])await assert.rejects(guard.send({...wire(),...change}),/RECIPIENT_DENIED/);
 await assert.rejects(new ControlledTestSendGuard(db,{...policy,canonicalConversationId:'missing'},send).send(wire()),/CONVERSATION_DENIED/);
 assert.equal(calls,0);assert.equal(used(db),0);
 }finally{db.db.close()}
});
test('policy validation rejects wildcard, accessor and group/broadcast recipients; snapshots caller mutation',async()=>{
 const db=setup();try{for(const p of [{...policy,recipient:'*'},{...policy,recipient:'123@g.us'},{...policy,recipient:'status@broadcast'},{...policy,recipient:'123@newsletter'},{...policy,get accountId(){throw Error('must not run')}}])assert.throws(()=>new ControlledTestSendGuard(db,p,async()=>submitted()),/CONTROLLED_TEST_POLICY/);
 const mutable={...policy};let calls=0;const guard=new ControlledTestSendGuard(db,mutable,async()=>{calls++;return submitted()});mutable.recipient='other-peer';await assert.rejects(guard.send({...wire(),conversationId:'other-peer'}),/RECIPIENT_DENIED/);await guard.send(wire());assert.equal(calls,1)
 }finally{db.db.close()}
});
test('concurrent independent connections reserve only three attempts before delayed provider operations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-guard-')),file=join(dir,'synthetic.sqlite');const a=setup(file),b=new V1Database(file);let calls=0,release!:()=>void;const wait=new Promise<void>(r=>{release=r});const send=async()=>{calls++;await wait;return submitted()};try{
 const guards=[new ControlledTestSendGuard(a,policy,send),new ControlledTestSendGuard(b,policy,send)];const jobs=Array.from({length:12},(_,i)=>guards[i%2].send(wire('concurrent-'+i)));assert.equal(calls,3);assert.equal(used(a),3);release();const results=await Promise.allSettled(jobs);assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal(results.filter(r=>r.status==='rejected').length,9)
 }finally{a.db.close();b.db.close();rmSync(dir,{recursive:true,force:true})}
});
test('restart preserves consumed slots and the remaining exact policy budget',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-guard-restart-')),file=join(dir,'synthetic.sqlite');let db=setup(file),calls=0;const send=async()=>{calls++;return submitted()};try{
 const first=new ControlledTestSendGuard(db,policy,send);await first.send(wire('one'));await first.send(wire('two'));db.db.close();db=new V1Database(file);const resumed=new ControlledTestSendGuard(db,policy,send);await resumed.send(wire('three'));await assert.rejects(resumed.send(wire('four')),/ATTEMPT_LIMIT/);assert.equal(calls,3);assert.equal(used(db),3)
 }finally{db.db.close();rmSync(dir,{recursive:true,force:true})}
});
test('throw, unknown and failed provider results each consume a slot and are never refunded',async()=>{
 const db=setup();let calls=0;const guard=new ControlledTestSendGuard(db,policy,async m=>{calls++;if(calls===1)throw Error('synthetic uncertain send');if(calls===2)return{status:'unknown',clientMessageId:m.clientMessageId};return{status:'failed',retryable:true,errorCode:'SYNTHETIC_FAILURE'}});try{
 await assert.rejects(guard.send(wire('throw')),/synthetic uncertain/);await guard.send(wire('unknown'));await guard.send(wire('failed'));await assert.rejects(guard.send(wire('fourth')),/ATTEMPT_LIMIT/);assert.equal(calls,3);assert.equal(used(db),3);assert.deepEqual(db.db.prepare('SELECT status FROM controlled_test_send_attempts ORDER BY ordinal').all(),[{status:'UNKNOWN'},{status:'UNKNOWN'},{status:'FAILED'}])
 }finally{db.db.close()}
});
test('crash after provider submission before disposition preserves counted UNKNOWN attempt',async()=>{
 const db=setup();let calls=0;try{db.db.exec("CREATE TRIGGER synthetic_guard_crash BEFORE UPDATE ON controlled_test_send_attempts WHEN NEW.status='SUBMITTED' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DISPOSITION_CRASH'); END");await assert.rejects(new ControlledTestSendGuard(db,policy,async()=>{calls++;return submitted()}).send(wire()),/SYNTHETIC_DISPOSITION_CRASH/);assert.equal(used(db),1);assert.equal((db.db.prepare('SELECT status FROM controlled_test_send_attempts').get() as any).status,'UNKNOWN');db.db.exec('DROP TRIGGER synthetic_guard_crash');const next=new ControlledTestSendGuard(db,policy,async()=>{calls++;return submitted()});await next.send(wire('two'));await next.send(wire('three'));await assert.rejects(next.send(wire('four')),/ATTEMPT_LIMIT/);assert.equal(calls,3)
 }finally{db.db.close()}
});
test('ignored budget update or attempt insert rejects and rolls back before provider call',async()=>{
 for(const trigger of ["CREATE TRIGGER synthetic_guard_fault BEFORE UPDATE ON controlled_test_send_budgets BEGIN SELECT RAISE(IGNORE); END","CREATE TRIGGER synthetic_guard_fault BEFORE INSERT ON controlled_test_send_attempts BEGIN SELECT RAISE(IGNORE); END"]){const db=setup();let calls=0;try{db.db.exec(trigger);await assert.rejects(new ControlledTestSendGuard(db,policy,async()=>{calls++;return submitted()}).send(wire()),/PERSISTENCE_REQUIRED/);assert.equal(calls,0);assert.equal(used(db),0);assert.equal((db.db.prepare('SELECT count(*) n FROM controlled_test_send_attempts').get() as any).n,0)}finally{db.db.close()}}
});
test('changed policy or rotated policy ID cannot reset same destination budget; demo reset retains evidence',async()=>{
 const db=setup();try{const guard=new ControlledTestSendGuard(db,policy,async()=>submitted());await guard.send(wire());await assert.rejects(new ControlledTestSendGuard(db,{...policy,policyId:'rotated-run'},async()=>submitted()).send(wire()),/POLICY_CONFLICT/);db.resetAndSeed();conversation(db);assert.equal(used(db),1);assert.equal((db.db.prepare('SELECT count(*) n FROM controlled_test_send_attempts').get() as any).n,1);await guard.send(wire('two'));await guard.send(wire('three'));await assert.rejects(guard.send(wire('four')),/ATTEMPT_LIMIT/)}finally{db.db.close()}
});
test('host opt-in with missing policy fences the actual outbound service before startup, without grants',async()=>{
 const old={...process.env};process.env.ORDER_CHANNEL='simulated';process.env.DEMO_GPT_ENABLED='false';process.env.V2_CANARY_RUNTIME_ENABLED='false';const channel=new SimulatedChannel();const created=createApp({dbFilename:':memory:',startupMode:'paused',channel,controlledTest:{}});try{await assert.rejects(created.service.outbound.send(wire()),/POLICY_REQUIRED/);assert.equal(channel.sendCount,0);assert.equal((created.service.database.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0)}finally{await created.app.close();created.service.database.db.close();process.env=old}
});
