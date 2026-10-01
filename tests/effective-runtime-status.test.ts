import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveRuntimeStatus} from '../src/effective-runtime-status.js';
const configured={paused:false,inquiryConfigured:true,inquiryApproved:true,piConfigured:true,v2Configured:true};
test('approved active scoped Pi inquiry projects V2 without enabling a global rollout',()=>{
 const old=process.env.ORDER_RUNTIME_MODE;process.env.ORDER_RUNTIME_MODE='V2';
 try{const s=effectiveRuntimeStatus(configured);assert.equal(s.runtimeMode,'V2');assert.equal(s.v2TrafficEnabled,true);assert.equal(s.effectiveRuntime.v2Traffic,'SCOPED');assert.equal(s.effectiveRuntime.processing,'SCOPED_INQUIRY');assert.equal(s.effectiveRuntime.aiProcessing,'enabled');assert.ok(!s.fallbackReasons.includes('PHASE0_V2_TRAFFIC_DISABLED'));assert.equal(s.aiCutoff,'SALES_ORDER.DRAFT')}
 finally{if(old===undefined)delete process.env.ORDER_RUNTIME_MODE;else process.env.ORDER_RUNTIME_MODE=old}
});
test('paused policy/model configuration cannot report active V2 traffic or AI processing',()=>{
 const s=effectiveRuntimeStatus({...configured,paused:true});assert.equal(s.v2TrafficEnabled,false);assert.equal(s.effectiveRuntime.mode,'PAUSED');assert.equal(s.effectiveRuntime.v2Traffic,'OFF');assert.equal(s.effectiveRuntime.aiProcessing,'paused');
});
test('global environment/model configuration alone is never scoped inquiry authorization',()=>{
 const old=process.env.ORDER_RUNTIME_MODE;process.env.ORDER_RUNTIME_MODE='V2';
 try{const s=effectiveRuntimeStatus({...configured,inquiryConfigured:false,inquiryApproved:false});assert.equal(s.v2TrafficEnabled,false);assert.equal(s.runtimeMode,'V1');assert.equal(s.effectiveRuntime.v2Traffic,'OFF');assert.equal(s.effectiveRuntime.aiProcessing,'configured');assert.ok(s.fallbackReasons.includes('PHASE0_V2_TRAFFIC_DISABLED'))}
 finally{if(old===undefined)delete process.env.ORDER_RUNTIME_MODE;else process.env.ORDER_RUNTIME_MODE=old}
});
test('revoked policy or missing Pi/runtime gate reports blocked inquiry rather than a working legacy fallback',()=>{
 for(const overrides of [{inquiryApproved:false},{piConfigured:false},{v2Configured:false}]){const s=effectiveRuntimeStatus({...configured,...overrides});assert.equal(s.v2TrafficEnabled,false);assert.equal(s.effectiveRuntime.mode,'BLOCKED');assert.equal(s.effectiveRuntime.processing,'INQUIRY_BLOCKED');assert.equal(s.effectiveRuntime.aiProcessing,'blocked')}
});
