import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {buildV3FreshnessVector, buildV3FreshnessVectorFromDatabase, freshnessVectorChangedClasses, isV3FreshnessVectorStale, validateV3FreshnessVector, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';

function input(): V3FreshnessVectorInput {
  return {identityScope:{accountId:'a',conversationId:'c',customerId:'customer-1',channelAccountId:'channel-1'},employeeProfile:{id:'profile-1',version:2},capabilityPolicy:{policyVersion:3,availableCapabilities:[{id:'quote',version:1},{id:'lookup',version:2}]},workItemOrderDraftRefs:{workItem:{id:'work-1',revision:4,status:'DRAFTING'},orderDraft:{id:'draft-1',revision:2,status:'DRAFT'}},canonicalBusiness:{quotations:[{id:'quote-1',revision:3,status:'SENT'}],acceptances:[],outbound:[{id:'out-1',revision:1,status:'SENT'}],salesOrders:[]},relevantErpEvidence:[{sourceId:'stock:product-1:warehouse-1',sourceVersion:7,kind:'stock'}],goalGraph:{version:null,dependencyRefs:[]},attachmentExtraction:{version:null,dependencyRefs:[]},retentionAccess:{version:1,dependencyRefs:[{id:'conversation:c',version:1}]},conversationBundle:{conversationRevision:8,bundleRevision:2,messageRefs:[{id:'message-1',version:8}]},authoritativeV2FreshnessFingerprint:'v2-authoritative-1'};
}

test('is deterministic, canonical, detached, deeply immutable, and versioned',()=>{const a=buildV3FreshnessVector(input()), b=buildV3FreshnessVector({...input(),capabilityPolicy:{...input().capabilityPolicy,availableCapabilities:[{id:'lookup',version:2},{id:'quote',version:1}]}});assert.equal(a.vectorHash,b.vectorHash);assert.equal(Object.isFrozen(a),true);assert.equal(Object.isFrozen(a.dependencies.canonicalBusiness.quotations),true);assert.equal(validateV3FreshnessVector(JSON.parse(JSON.stringify(a))).vectorHash,a.vectorHash);});
test('relevant dependency changes stale and identify only their class',()=>{const prior=buildV3FreshnessVector(input());const next=buildV3FreshnessVector({...input(),employeeProfile:{id:'profile-1',version:3},retentionAccess:{version:2,dependencyRefs:[{id:'conversation:c',version:1}]}});assert.equal(isV3FreshnessVectorStale(prior,next),true);assert.deepEqual(freshnessVectorChangedClasses(prior,next),['employeeProfile','retentionAccess']);});
function databaseInput(): Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'> {
  const base=input();
  const {authoritativeV2FreshnessFingerprint:_, ...withoutFingerprint}=base;
  return {...withoutFingerprint, identityScope:{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',channelAccountId:'demo-account'}, employeeProfile:{id:'sales-digital-employee',version:1}};
}

function scopedDatabase(): V1Database {
  const database=new V1Database(':memory:');
  database.resetAndSeed();
  database.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,active_order_draft_id,active_quotation_id,assigned_profile,blocking_reason,source_message_id,created_at,updated_at) VALUES('wi-v3',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('demo-account','conv-001','CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'goal','draft-v3',null,null,null,null,'2026-09-10','2026-09-10');
  database.db.prepare("INSERT INTO order_drafts VALUES('draft-v3','wi-v3',?,?,?,'CURRENT',1,NULL,'SG-MAIN','SGD',NULL,'2026-09-10','2026-09-10')").run('demo-account','conv-001','CUST-001');
  database.db.prepare("INSERT INTO order_draft_lines VALUES('line-v3','draft-v3',1,'ayam','1','CTN',NULL,'FCH-WHOLE-12','CTN',NULL)").run();
  return database;
}

test('DB-derived unrelated product, stock, and price changes do not stale the scoped vector',()=>{
  const database=scopedDatabase(), prior=buildV3FreshnessVectorFromDatabase(database.db,databaseInput());
  database.db.prepare("INSERT INTO products VALUES('UNRELATED-B','UNRELATED-B','Unrelated product','PCS',1)").run();
  database.db.prepare("INSERT INTO stock_balances VALUES('UNRELATED-B','SG-MAIN','999')").run();
  database.db.prepare("INSERT INTO customer_prices VALUES('price-unrelated-b','CUST-001','UNRELATED-B','CTN',1,'SGD','2026-01-01',NULL)").run();
  const next=buildV3FreshnessVectorFromDatabase(database.db,databaseInput());
  assert.equal(isV3FreshnessVectorStale(prior,next),false);
  assert.deepEqual(freshnessVectorChangedClasses(prior,next),[]);
});

test('DB-derived relevant ERP and profile changes stale the scoped vector',()=>{
  const database=scopedDatabase(), prior=buildV3FreshnessVectorFromDatabase(database.db,databaseInput());
  database.db.prepare("UPDATE customer_prices SET unit_price_cents=4801 WHERE id='price-ayam'").run();
  const priceChanged=buildV3FreshnessVectorFromDatabase(database.db,databaseInput());
  assert.equal(isV3FreshnessVectorStale(prior,priceChanged),true);
  database.db.prepare("UPDATE employee_profiles SET version=version+1 WHERE id='sales-digital-employee'").run();
  assert.throws(()=>buildV3FreshnessVectorFromDatabase(database.db,databaseInput()),/PROFILE_VERSION_MISMATCH/);
});

test('DB adapter derives and verifies conversation scope and profile version',()=>{
  const database=scopedDatabase(), base=databaseInput();
  assert.throws(()=>buildV3FreshnessVectorFromDatabase(database.db,{...base,identityScope:{...base.identityScope,channelAccountId:'forged-account'}}),/CHANNEL_ACCOUNT_MISMATCH/);
  assert.throws(()=>buildV3FreshnessVectorFromDatabase(database.db,{...base,identityScope:{...base.identityScope,customerId:'forged-customer'}}),/CUSTOMER_MISMATCH/);
  assert.throws(()=>buildV3FreshnessVectorFromDatabase(database.db,{...base,employeeProfile:{...base.employeeProfile,version:999}}),/PROFILE_VERSION_MISMATCH/);
});
test('all mandatory dependency classes are host-selected and cannot be omitted',()=>{const invalid={...input()} as Record<string,unknown>;delete invalid.goalGraph;assert.throws(()=>buildV3FreshnessVector(invalid as V3FreshnessVectorInput),/PLACEHOLDER_DEPENDENCY/);const noProfile={...input(),employeeProfile:undefined} as unknown as V3FreshnessVectorInput;assert.throws(()=>buildV3FreshnessVector(noProfile),/UNDEFINED|PROFILE/);});
test('accessors, cycles, malformed values, and custom prototypes fail closed without invoking getters',()=>{const supplied=input() as Record<string,unknown>;let calls=0;Object.defineProperty(supplied,'identityScope',{enumerable:true,get(){calls++;throw new Error('getter')}});assert.throws(()=>buildV3FreshnessVector(supplied as V3FreshnessVectorInput),/ACCESSOR/);assert.equal(calls,0);const cyclic=input() as Record<string,unknown>;cyclic.cycle=cyclic;assert.throws(()=>buildV3FreshnessVector(cyclic as V3FreshnessVectorInput),/PLAIN_JSON/);const custom=Object.create({bad:true});Object.assign(custom,input());assert.throws(()=>buildV3FreshnessVector(custom),/PLAIN_JSON/);});
test('tampering fails closed and customer text is not a vector input',()=>{const vector=buildV3FreshnessVector(input());const tampered=JSON.parse(JSON.stringify(vector));tampered.dependencies.employeeProfile.version=99;assert.throws(()=>validateV3FreshnessVector(tampered),/INTEGRITY/);assert.equal('customerText' in vector.dependencies,false);});
