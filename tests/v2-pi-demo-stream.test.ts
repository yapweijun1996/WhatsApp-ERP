import test from 'node:test';
import assert from 'node:assert/strict';
import type { DemoGatewaySession } from '../src/gateway.js';
import { demoGatewayModel } from '../src/gateway.js';
import { createPiDemoStream } from '../src/v2-pi-demo-stream.js';

const config={enabled:true,baseUrl:'https://gpt.example',projectId:'pi-stream-test',origin:'http://127.0.0.1:32111',model:'demo-fast'} as const;
const model=demoGatewayModel(config);
const context={
  systemPrompt:'ROLE\n{"turnId":"turn-pi","piHarnessWorkflow":{"phase":"GENERAL","finalOnly":false}}',
  messages:[{role:'user',content:'Continue the V2 observe/decide loop.',timestamp:Date.now()}],
  tools:[{name:'get_customer_context',description:'context',parameters:{type:'object',properties:{accountId:{type:'string'},conversationId:{type:'string'},customerId:{type:'string'}},required:['accountId','conversationId','customerId'],additionalProperties:false}}],
};
function session(text:string){return {completeText:async()=>({text,responseId:'resp-test',usage:{inputTokens:10,outputTokens:5,totalTokens:15}})} as unknown as DemoGatewaySession}

test('Pi Demo stream converts strict model envelope into a real Pi toolCall block',async()=>{
  const fn=createPiDemoStream({session:session(JSON.stringify({kind:'tool_call',name:'get_customer_context',arguments:{accountId:'a',conversationId:'c',customerId:'u'}})),config});
  const message=await fn(model,context as any,{}).result();
  assert.equal(message.stopReason,'toolUse');assert.equal(message.content.length,1);assert.equal(message.content[0].type,'toolCall');
  assert.equal((message.content[0] as any).name,'get_customer_context');assert.deepEqual((message.content[0] as any).arguments,{accountId:'a',conversationId:'c',customerId:'u'});
});

test('Pi Demo stream converts final envelope into the response-plan text Pi runtime validates',async()=>{
  const plan={turnId:'turn-pi',intent:'ACKNOWLEDGE',connectiveText:'Hello, how can I help?',factClaims:[],outboundPurpose:'acknowledgement'};
  const fn=createPiDemoStream({session:session(JSON.stringify({kind:'final_response',responsePlan:plan})),config});
  const message=await fn(model,context as any,{}).result();
  assert.equal(message.stopReason,'stop');assert.equal(message.content[0].type,'text');assert.deepEqual(JSON.parse((message.content[0] as any).text),plan);
});


test('Pi Demo prompt requires one semantic action envelope and forbids bare tool arguments',async()=>{
  let prompt='';
  const capture={completeText:async(input:string)=>{prompt=input;return{text:JSON.stringify({kind:'final_response',responsePlan:{turnId:'turn-pi',intent:'ACKNOWLEDGE',connectiveText:'Okay.',factClaims:[],outboundPurpose:'acknowledgement'}}),responseId:'resp-test',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}}} as unknown as DemoGatewaySession;
  const fn=createPiDemoStream({session:capture,config});
  await fn(model,context as any,{}).result();
  const parsed=JSON.parse(prompt);
  assert.match(parsed.instruction,/Every decision MUST be one envelope/);
  assert.match(parsed.instruction,/Never output bare tool arguments/);
  assert.match(parsed.instruction,/infer the customer goal semantically/);
  assert.match(parsed.instruction,/call the appropriate capability instead of merely saying you will do it/);
  assert.equal(parsed.tools[0].description,'context');
});

test('malformed Demo output remains text so Pi runtime owns its single repair boundary',async()=>{
  const raw='```json\n{"kind":"final_response"}\n```';
  const fn=createPiDemoStream({session:session(raw),config});
  const message=await fn(model,context as any,{}).result();
  assert.equal(message.stopReason,'stop');assert.equal((message.content[0] as any).text,raw);
});
