import test from 'node:test';
import assert from 'node:assert/strict';
import {CommerceService} from '../src/commerce.js';
import {SimulatedChannel} from '../src/channels.js';
import {scriptedSemanticAgentFactory,goldenOffer} from './semantic-agent.js';
import type {IncomingChannelMessage} from '../src/channel-contract.js';
const input=(sender:string,phone:string):IncomingChannelMessage=>({accountId:'demo-account',channel:'whatsapp',conversationId:'new-identity-conversation',externalMessageId:'identity-regression',sender:{externalId:sender,phone},type:'text',text:'Synthetic order',occurredAt:new Date().toISOString()});
async function run(m:IncomingChannelMessage,phone?:string,id?:string){
 const previous={phone:process.env.WHATSAPP_QR_CUSTOMER_PHONE,id:process.env.WHATSAPP_QR_CUSTOMER_ID};
 if(phone)process.env.WHATSAPP_QR_CUSTOMER_PHONE=phone;else delete process.env.WHATSAPP_QR_CUSTOMER_PHONE;
 if(id)process.env.WHATSAPP_QR_CUSTOMER_ID=id;else delete process.env.WHATSAPP_QR_CUSTOMER_ID;
 const ch=new SimulatedChannel();await ch.connect();const s=new CommerceService(undefined,ch,undefined,scriptedSemanticAgentFactory([goldenOffer()]));s.resetAndSeed();
 try{await s.inbound(m);return {conversation:s.database.db.prepare('SELECT customer_id FROM conversations WHERE external_conversation_id=?').get(m.conversationId) as any,binding:s.database.db.prepare('SELECT customer_id FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?').get(m.accountId,m.sender.externalId) as any}}
 finally{s.database.db.close();await ch.disconnect();for(const [key,value] of [['WHATSAPP_QR_CUSTOMER_PHONE',previous.phone],['WHATSAPP_QR_CUSTOMER_ID',previous.id]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value}}
}
test('legacy seam never defaults an unknown sender to a customer when only phone is configured',async()=>{const r=await run(input('synthetic-unknown','+6599990000'),'+6599990000');assert.equal(r.conversation.customer_id,null);assert.equal(r.binding,undefined)});
test('existing canonical sender binding resolves a new conversation without default/env assignment',async()=>{const r=await run(input('+6591110001','+6591110001'));assert.equal(r.conversation.customer_id,'CUST-001');assert.equal(r.binding.customer_id,'CUST-001')});
test('explicit phone and customer evidence can bind only the specified existing customer',async()=>{const r=await run(input('synthetic-explicit','+6599990000'),'+6599990000','CUST-001');assert.equal(r.conversation.customer_id,'CUST-001')});
test('a phone in another account does not borrow a canonical binding',async()=>{const m=input('+6591110001','+6591110001');m.accountId='synthetic-other-account';const r=await run(m);assert.equal(r.conversation.customer_id,null);assert.equal(r.binding,undefined)});
