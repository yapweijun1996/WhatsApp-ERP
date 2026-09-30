import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { V1Database } from '../src/database.js';
import { authorizeCapability } from '../src/v2-capability-authorization.js';
import { listCapabilities } from '../src/v2-capability-registry.js';
import { EmployeeProfileResolver, INITIAL_SALES_PROFILE_ID, profileAuthorization } from '../src/v2-employee-profile.js';
const A='demo-account',C='conv-001',U='CUST-001';
const args=()=>({accountId:A,conversationId:C,customerId:U});
function db(){const d=new V1Database(':memory:');d.resetAndSeed();return d}
function setJson(d:V1Database,column:string,value:unknown){d.db.prepare(`UPDATE employee_profiles SET ${column}=? WHERE id=?`).run(JSON.stringify(value),INITIAL_SALES_PROFILE_ID)}

test('CTX-001 seeds one active sales profile backed exactly by current registry permissions',()=>{
 const d=db(),rows=d.db.prepare('SELECT * FROM employee_profiles').all() as any[];assert.equal(rows.length,1);assert.equal(rows[0].id,INITIAL_SALES_PROFILE_ID);assert.equal(rows[0].active,1);
 const p=new EmployeeProfileResolver(d.db).resolve();assert.deepEqual(p.permissions,listCapabilities().map(x=>x.permission.identifier));assert.equal(p.turnBudgets.maxModelTurns,8);assert.equal(p.turnBudgets.maxCapabilityCalls,6);assert.equal(p.turnBudgets.perCallTimeoutMs,15000);assert.equal(p.turnBudgets.turnTimeoutMs,60000);assert.equal(p.turnBudgets.maxRepairAttempts,1);assert.ok(p.forbiddenCommitments.includes('POST_SALES_ORDER'));assert.ok(p.forbiddenCommitments.includes('CREATE_DELIVERY_ORDER'));
});

test('CTX-001 resolved profile is detached deeply immutable and has no secret or staff authority surface',()=>{
 const d=db(),p=new EmployeeProfileResolver(d.db).resolve(),auth=profileAuthorization(p);assert.equal(Object.isFrozen(p),true);assert.equal(Object.isFrozen(p.permissions),true);assert.equal(Object.isFrozen(p.turnBudgets),true);assert.notStrictEqual(auth.permissions,p.permissions);assert.equal(Object.isFrozen(auth.permissions),true);
 const serialized=JSON.stringify(p);for(const marker of ['password','apiKey','token','staff_session','staffAuthority','execute_sql','post_sales_order','create_delivery_order'])assert.equal(serialized.includes(marker),false,marker);
});

test('CTX-001 profile feeds CAP-003 and permission narrowing denies the removed capability',()=>{
 const d=db(),resolver=new EmployeeProfileResolver(d.db),p=resolver.resolve(),auth=profileAuthorization(p);const allowed=authorizeCapability({name:'get_customer_context',arguments:args()},{db:d.db,...auth,accountId:A,conversationId:C,customerId:U});assert.equal(allowed.capability.name,'get_customer_context');
 setJson(d,'capability_permissions_json',p.permissions.filter(x=>x!=='v2.capability.get_customer_context'));const narrowed=profileAuthorization(resolver.resolve());assert.throws(()=>authorizeCapability({name:'get_customer_context',arguments:args()},{db:d.db,...narrowed,accountId:A,conversationId:C,customerId:U}),/PERMISSION_DENIED/);
});

test('CTX-001 fails closed for missing inactive malformed duplicate unknown and staff-like permissions',()=>{
 let d=db(),resolver=new EmployeeProfileResolver(d.db);assert.throws(()=>resolver.resolve('missing'),/EMPLOYEE_PROFILE_NOT_FOUND/);d.db.prepare('UPDATE employee_profiles SET active=0').run();assert.throws(()=>resolver.resolve(),/INACTIVE/);
 d=db();d.db.prepare("UPDATE employee_profiles SET capability_permissions_json='not-json'").run();assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),/PERMISSIONS_JSON/);
 for(const permissions of [['v2.capability.get_customer_context','v2.capability.get_customer_context'],['v2.capability.get_customer_context','v2.capability.not_registered'],['v2.capability.post_sales_order'],['staff.post_sales_order'],['execute_sql']]){d=db();setJson(d,'capability_permissions_json',permissions);assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),/PERMISSIONS_DUPLICATE|PERMISSION_NOT_REGISTERED/)}
});

test('CTX-001 rejects malformed config and unsafe budget shapes',()=>{
 for(const [column,value,pattern] of [['language_policy_json',{mode:'FOLLOW_PROMPT',fallbackLocale:'en-SG'},/LANGUAGE_POLICY_MODE/],['turn_budgets_json',{maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:70000,turnTimeoutMs:60000,maxRepairAttempts:1},/CALL_TIMEOUT_EXCEEDS_TURN/],['turn_budgets_json',{maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15000,turnTimeoutMs:60000,maxRepairAttempts:1,staff:true},/TURN_BUDGETS_FIELDS/]] as const){const d=db();setJson(d,column,value);assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),pattern)}
});

test('CTX-001 prompt/model fields cannot widen profile or registry authority',()=>{
 const d=db(),auth=profileAuthorization(new EmployeeProfileResolver(d.db).resolve());assert.throws(()=>authorizeCapability({name:'get_customer_context',arguments:{...args(),role:'admin',profileId:'admin',permissions:['v2.capability.post_sales_order']}},{db:d.db,...auth,accountId:A,conversationId:C,customerId:U}),/ARGUMENTS_UNKNOWN_FIELD/);
 for(const name of ['post_sales_order','confirm_sales_order','create_delivery_order','execute_sql'])assert.throws(()=>authorizeCapability({name,arguments:args()},{db:d.db,...auth,accountId:A,conversationId:C,customerId:U}),/UNKNOWN_CAPABILITY/);
});

test('CTX-001 reset restores deterministic canonical profile',()=>{
 const d=db();setJson(d,'capability_permissions_json',['v2.capability.get_customer_context']);d.db.prepare("UPDATE employee_profiles SET mission='changed',active=0").run();d.resetAndSeed();const p=new EmployeeProfileResolver(d.db).resolve();assert.equal(p.id,INITIAL_SALES_PROFILE_ID);assert.equal(p.active,true);assert.deepEqual(p.permissions,listCapabilities().map(x=>x.permission.identifier));assert.match(p.mission,/SALES_ORDER\.DRAFT/);
});

test('CTX-001 additive migration seeds the initial profile without resetting an existing V1 database',()=>{
 const d=db();d.db.prepare('DELETE FROM employee_profiles').run();assert.equal((d.db.prepare('SELECT count(*) n FROM channel_accounts').get() as any).n,1);const filename='/tmp/waerp-ctx001-existing.db';
 try{for(const suffix of ['', '-wal','-shm'])rmSync(filename+suffix,{force:true})}catch{}
 const existing=new V1Database(filename);existing.resetAndSeed();existing.db.prepare('DELETE FROM employee_profiles').run();existing.db.close();
 const reopened=new V1Database(filename);try{const p=new EmployeeProfileResolver(reopened.db).resolve();assert.equal(p.id,INITIAL_SALES_PROFILE_ID);assert.equal((reopened.db.prepare('SELECT count(*) n FROM channel_accounts').get() as any).n,1)}finally{reopened.db.close();for(const suffix of ['', '-wal','-shm'])try{rmSync(filename+suffix,{force:true})}catch{}}
});

test('CTX-001 profile config cannot widen frozen pilot ceilings or grow policy payloads without bound',()=>{
 const widened=[
  {maxModelTurns:9,maxCapabilityCalls:6,perCallTimeoutMs:15000,turnTimeoutMs:60000,maxRepairAttempts:1},
  {maxModelTurns:8,maxCapabilityCalls:7,perCallTimeoutMs:15000,turnTimeoutMs:60000,maxRepairAttempts:1},
  {maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15001,turnTimeoutMs:60000,maxRepairAttempts:1},
  {maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15000,turnTimeoutMs:60001,maxRepairAttempts:1},
  {maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15000,turnTimeoutMs:60000,maxRepairAttempts:2},
 ];
 for(const budget of widened){const d=db();setJson(d,'turn_budgets_json',budget);assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),/TURN_BUDGET_EXCEEDS_PILOT_CAP/)}
 const d=db();setJson(d,'escalation_rules_json',Array.from({length:33},(_,i)=>`RULE_${i}`));assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),/ESCALATION_RULES_SIZE/);
 d.db.prepare('UPDATE employee_profiles SET forbidden_commitments_json=?').run('"'+ 'x'.repeat(17000) +'"');assert.throws(()=>new EmployeeProfileResolver(d.db).resolve(),/FORBIDDEN_COMMITMENTS_JSON/);
});
