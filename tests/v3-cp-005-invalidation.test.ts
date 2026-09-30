import test from 'node:test';
import assert from 'node:assert/strict';
import {buildV3FreshnessVector, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';
import {projectV3InvalidationEvent, validateV3InvalidationEvent} from '../src/v3-invalidation.js';

function vector(): V3FreshnessVectorInput {
  return {identityScope:{accountId:'a',conversationId:'c',customerId:'customer',channelAccountId:'channel'},employeeProfile:{id:'profile',version:1},capabilityPolicy:{policyVersion:1,availableCapabilities:[{id:'quote',version:1}]},workItemOrderDraftRefs:{workItem:null,orderDraft:null},canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]},relevantErpEvidence:[{sourceId:'erp:stock:A',sourceVersion:1,kind:'stock'}],goalGraph:{version:1,dependencyRefs:[{id:'goal:c',version:1}]},attachmentExtraction:{version:1,dependencyRefs:[{id:'attachment:A',version:1}]},retentionAccess:{version:1,dependencyRefs:[{id:'conversation:c',version:1}]},conversationBundle:{conversationRevision:1,bundleRevision:1,messageRefs:[{id:'message-1',version:1}]},authoritativeV2FreshnessFingerprint:'v2'};
}

test('CP-005 projects a versioned scope-bound invalidation without new inbound', () => {
  const before=buildV3FreshnessVector(vector());
  const after=buildV3FreshnessVector({...vector(),goalGraph:{version:2,dependencyRefs:[{id:'goal:c',version:2}]}});
  const result=projectV3InvalidationEvent(before,after,'a','c','2026-09-14T00:00:00.000Z');
  assert.equal(result.stale,true); assert.deepEqual(result.changedClasses,['goalGraph']);
  assert.equal(result.event?.contractVersion,'V3-CP-005'); assert.equal(result.event?.schemaVersion,1);
  assert.deepEqual(validateV3InvalidationEvent(result.event),result.event);
  assert.equal(after.dependencies.conversationBundle.messageRefs[0].id,'message-1');
});

test('unrelated dependency changes do not stale the current plan', () => {
  const before=buildV3FreshnessVector(vector());
  const after=buildV3FreshnessVector({...vector(),goalGraph:{version:1,dependencyRefs:[{id:'goal:c',version:1}]},relevantErpEvidence:[{sourceId:'erp:stock:UNRELATED',sourceVersion:99,kind:'stock'}]});
  const result=projectV3InvalidationEvent(before,after,'a','c','2026-09-14T00:00:00.000Z');
  assert.deepEqual(result.changedClasses,['relevantErpEvidence']);
  assert.equal(result.stale,true);
  const unrelated=buildV3FreshnessVector({...vector(),canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]}});
  assert.equal(projectV3InvalidationEvent(before,unrelated,'a','c','2026-09-14T00:00:00.000Z').stale,false);
});

test('profile, policy, ERP, extraction, and retention changes are individually scoped', () => {
  const before=buildV3FreshnessVector(vector());
  for (const [key,change] of [
    ['employeeProfile',{id:'profile',version:2}],
    ['capabilityPolicy',{policyVersion:2,availableCapabilities:[{id:'quote',version:1}]}],
    ['relevantErpEvidence',[{sourceId:'erp:stock:A',sourceVersion:2,kind:'stock'}]],
    ['attachmentExtraction',{version:2,dependencyRefs:[{id:'attachment:A',version:2}]}],
    ['retentionAccess',{version:2,dependencyRefs:[{id:'conversation:c',version:1}]}],
  ] as const) {
    const after=buildV3FreshnessVector({...vector(),[key]:change});
    const result=projectV3InvalidationEvent(before,after,'a','c','2026-09-14T00:00:00.000Z');
    assert.deepEqual(result.changedClasses,[key]);
  }
});

test('a message/bundle-only change is not a non-message invalidation', () => {
  const before=buildV3FreshnessVector(vector());
  const after=buildV3FreshnessVector({...vector(),conversationBundle:{conversationRevision:2,bundleRevision:2,messageRefs:[{id:'message-2',version:2}]}});
  const result=projectV3InvalidationEvent(before,after,'a','c','2026-09-14T00:00:00.000Z');
  assert.equal(result.stale,false); assert.deepEqual(result.changedClasses,[]); assert.equal(result.event,null);
});

test('event scope and malformed events fail closed', () => {
  const before=buildV3FreshnessVector(vector()), after=buildV3FreshnessVector({...vector(),retentionAccess:{version:2,dependencyRefs:[{id:'conversation:c',version:1}]}});
  assert.throws(()=>projectV3InvalidationEvent(before,after,'other-account','c','2026-09-14T00:00:00.000Z'),/SCOPE/);
  const event=projectV3InvalidationEvent(before,after,'a','c','2026-09-14T00:00:00.000Z').event!;
  assert.throws(()=>validateV3InvalidationEvent({...event,changedClasses:[]}),/CLASS/);
  assert.throws(()=>validateV3InvalidationEvent({...event,eventId:'forged'}),/EVENT_ID/);
});
