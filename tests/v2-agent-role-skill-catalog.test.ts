import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_CAPABILITY_GUIDES, AGENT_SKILLS, agentCapabilityGuide, projectAgentRole, renderRoleSkillPreamble, resolveAgentRole, resolveRoleSkills, roleCapabilityNames } from '../src/v2-agent-role-skill-catalog.js';
import { APPROVED_EMPLOYEE_CAPABILITY_NAMES } from '../src/v2-capability-registry.js';

test('Pi Harness sales role loads reviewed skills and tools without widening the registry',()=>{
  const role=resolveAgentRole('sales-digital-employee');
  const skills=resolveRoleSkills(role),tools=roleCapabilityNames(role);
  assert.deepEqual(skills.map(skill=>skill.id),['customer-service','order-taking','quotation','commitment']);
  assert.deepEqual(new Set(tools),new Set(APPROVED_EMPLOYEE_CAPABILITY_NAMES));
  assert.ok(tools.every(name=>!['post_sales_order','confirm_sales_order','create_delivery_order','do_ready'].includes(name)));
  const projected=projectAgentRole(role);
  assert.equal(projected.engine,'pi-agent-core');assert.equal(projected.authority,'NARROWING_ONLY');assert.equal(projected.skills.length,4);assert.equal(projected.tools.length,APPROVED_EMPLOYEE_CAPABILITY_NAMES.length);
  const preamble=renderRoleSkillPreamble(role);assert.match(preamble,/PI HARNESS ROLE/);assert.match(preamble,/WorkItem alone is not completion/i);assert.match(preamble,/choose skills\/tools semantically/i);assert.match(preamble,/do not merely promise/i);assert.match(preamble,/SALES_ORDER\.DRAFT/);for(const title of ['Customer Service','Order Taking','Quotation','Commitment'])assert.match(preamble,new RegExp(title));assert.ok(Buffer.byteLength(preamble)<2000);
});

test('every employee capability has bounded AI-facing semantics without widening authority',()=>{
  assert.deepEqual(Object.keys(AGENT_CAPABILITY_GUIDES),[...APPROVED_EMPLOYEE_CAPABILITY_NAMES]);
  for(const name of APPROVED_EMPLOYEE_CAPABILITY_NAMES){
    const guide=agentCapabilityGuide(name);assert.ok(guide.length>20&&guide.length<360);assert.doesNotMatch(guide,/post sales order|confirm sales order|create delivery order/i);
  }
  assert.match(agentCapabilityGuide('get_or_create_work_item'),/does not capture order details/i);
  assert.match(agentCapabilityGuide('record_customer_commitment'),/ACCEPT creates exactly one Draft Sales Order/i);
});

test('customer-service role is a strict capability subset and unknown roles fail closed',()=>{
  const role=resolveAgentRole('customer-service-digital-employee'),tools=roleCapabilityNames(role);
  assert.deepEqual(tools,['get_customer_context','get_commerce_status','request_human_handoff']);
  assert.ok(tools.length<APPROVED_EMPLOYEE_CAPABILITY_NAMES.length);
  assert.throws(()=>resolveAgentRole('admin-agent'),/ROLE_NOT_FOUND/);
  assert.equal(AGENT_SKILLS['customer-service'].instructions.some(x=>/currentTime/.test(x)),true);
});

import { piWorkflowPolicy } from '../src/v2-pi-workflow-policy.js';

test('Pi Harness policy does not classify customer language and leaves semantic routing to AI', () => {
  for (const text of ['现在几点','where is my order status?','Yes please.','OK confirm','Hi, same as last week.']) {
    const context:any={inboundMessageRef:{id:'m1'},recentTranscript:{messages:[{id:'m1',direction:'INBOUND',text}]},activeQuotationSalesOrder:{quotation:null,salesOrder:null},orderDraft:null};
    const policy=piWorkflowPolicy(context,{actions:[]} as any);
    assert.equal(policy.phase,'AI_FIRST');
    assert.equal(policy.finalOnly,false);
    assert.equal(policy.allowedCapabilityNames,undefined);
    assert.deepEqual(policy.activeSkillIds,['customer-service','order-taking','quotation','commitment']);
  }
});

test('Pi Harness policy only enforces the canonical Draft SO autonomy stop', () => {
  const context:any={activeQuotationSalesOrder:{salesOrder:{status:'DRAFT'}}};
  const policy=piWorkflowPolicy(context,{actions:[]} as any);
  assert.equal(policy.phase,'SALES_ORDER_DRAFT_STOP');
  assert.equal(policy.finalOnly,true);
  assert.deepEqual(policy.allowedCapabilityNames,[]);
});


test('quotation template grounding contract is visible to the model tool guide',()=>{
  const guide=agentCapabilityGuide('send_quotation');
  assert.match(guide,/\{\{quotation_number\}\}/);
  assert.match(guide,/\{\{currency\}\}/);
  assert.match(guide,/\{\{total\}\}/);
  assert.match(guide,/AI-authored/);
});
