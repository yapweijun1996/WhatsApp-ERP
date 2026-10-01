import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QrDemoAdapter,SimulatedChannel} from '../src/channels.js';
import {createPairingOwnerControl} from '../src/pairing-owner-auth.js';
import {createApp} from '../src/app.js';
const config={issuer:'https://test-only.cloudflareaccess.com',audience:'synthetic-app-aud',ownerEmail:'owner@example.test',publicOrigin:'https://erp.example.test'};
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'test-only-key',alg:'RS256',use:'sig'};
const token=(changes:Record<string,unknown>={},alg='RS256')=>{const h=Buffer.from(JSON.stringify({alg,kid:jwk.kid})).toString('base64url');const b=Buffer.from(JSON.stringify({iss:config.issuer,aud:[config.audience],email:config.ownerEmail,type:'app',exp:Date.now()/1000+60,...changes})).toString('base64url');return h+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+b),keys.privateKey).toString('base64url')};
test('pairing Access verifies signed exact app/owner session; spoofed identity, expiry, audience, issuer and signature fail closed',async()=>{
 const control=createPairingOwnerControl(config,async()=>[jwk]);
 assert.equal(await control.verifyOwner(token()),true);
 for(const t of [token({aud:['other-app']}),token({email:'other@example.test'}),token({iss:'https://other.cloudflareaccess.com'}),token({exp:0}),token({nbf:Date.now()/1000+60}),token({},'none'),token().slice(0,-30)+'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','unsigned'])assert.equal(await control.verifyOwner(t),false);
 const failing=createPairingOwnerControl(config,async()=>{throw Error('PRIVATE_PROVIDER_DETAIL')});assert.equal(await failing.verifyOwner(token()),false);
});
test('paused owner route authenticates and bounds reconnect while commerce writes remain blocked',async()=>{
 const saved={...process.env};process.env.ORDER_CHANNEL='whatsapp-qr';process.env.DEMO_GPT_ENABLED='false';process.env.V2_CANARY_RUNTIME_ENABLED='false';
 class FakePairing extends SimulatedChannel{requests=0;fail=false;async reconnectForPairing(){this.requests++;if(this.fail)throw Error('SECRET_PROVIDER_FAILURE')}getStatusInfo(){return{mode:'whatsapp-qr',status:'disconnected',qrReady:false,qr:null}}}
 const channel=new FakePairing();const {app,service,startupReady}=createApp({startupMode:'paused',dbFilename:':memory:',channel,pairingOwnerControl:createPairingOwnerControl(config,async()=>[jwk])});
 const before=service.database.db.prepare('select count(*) n from messages').get();
 const headers={origin:config.publicOrigin,'x-waerp-pairing-action':'regenerate','cf-access-jwt-assertion':token()};
 try{
  await startupReady;
  assert.equal((await app.inject({method:'POST',url:'/api/channel/pairing',headers:{origin:config.publicOrigin}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/channel/pairing',headers:{...headers,origin:'https://attacker.test'}})).statusCode,403);
  assert.equal(channel.requests,0);
  const ok=await app.inject({method:'POST',url:'/api/channel/pairing',headers});assert.equal(ok.statusCode,200);assert.equal(ok.json().pairingControl.processingPaused,true);assert.equal(channel.requests,1);
  assert.equal((await app.inject({method:'POST',url:'/api/channel/pairing',headers})).statusCode,429);
  assert.equal((await app.inject({method:'POST',url:'/api/reset',headers})).statusCode,503);
  assert.deepEqual(service.database.db.prepare('select count(*) n from messages').get(),before);assert.equal(channel.sendCount,0);
  await channel.connect();assert.equal((await app.inject({method:'POST',url:'/api/channel/pairing',headers})).statusCode,409);
 }finally{await app.close();service.database.db.close();process.env=saved}
});
test('QR expiry/disconnect clears stale code; owner reconnect never logs out or deletes auth and ignores old socket events',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qr-owner-synthetic-'));let now=1000;const sockets:any[]=[];
 const factory=()=>{const handlers:Record<string,Function>={};const sock:any={ev:{on:(name:string,fn:Function)=>{handlers[name]=fn}},end:()=>{},sendPresenceUpdate:async()=>{},sendMessage:()=>{throw Error('UNEXPECTED_SEND')},emit:async(name:string,value:any)=>{await handlers[name]?.(value)}};sockets.push(sock);return sock};
 const channel=new QrDemoAdapter(dir,'synthetic-account',factory,()=>now);
 try{
  await channel.connect();await sockets[0].emit('connection.update',{qr:'SYNTHETIC_NOT_A_REAL_QR'});assert.equal(channel.getStatusInfo().qrReady,true);
  now+=55_001;assert.equal(channel.getStatusInfo().qrReady,false);assert.equal(channel.getStatusInfo().qr,null);
  await sockets[0].emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});assert.equal(channel.getStatusInfo().qrReady,false);
  await channel.reconnectForPairing();assert.equal(sockets.length,2);
  await sockets[0].emit('connection.update',{qr:'OLD_SOCKET_SYNTHETIC'});assert.equal(channel.getStatusInfo().qrReady,false);
  await sockets[1].emit('connection.update',{qr:'FRESH_SOCKET_SYNTHETIC'});assert.equal(channel.getStatusInfo().qrReady,true);
  await sockets[1].emit('connection.update',{connection:'open'});assert.equal(await channel.getStatus(),'connected');assert.equal(channel.getStatusInfo().qr,null);
  await assert.rejects(channel.reconnectForPairing(),/WHATSAPP_ALREADY_CONNECTED/);
 }finally{await channel.disconnect();rmSync(dir,{recursive:true,force:true})}
});
test('reconnect failures return fixed errors without provider details and do not change business records',async()=>{
 const saved={...process.env};process.env.ORDER_CHANNEL='whatsapp-qr';process.env.DEMO_GPT_ENABLED='false';process.env.V2_CANARY_RUNTIME_ENABLED='false';
 class FailingPairing extends SimulatedChannel{async reconnectForPairing(){throw Error('PRIVATE_SESSION_DETAILS_MUST_NOT_ESCAPE')}}
 const channel=new FailingPairing();const {app,service}=createApp({startupMode:'paused',dbFilename:':memory:',channel,pairingOwnerControl:createPairingOwnerControl(config,async()=>[jwk])});
 try{
  const before=service.database.db.prepare('select count(*) n from messages').get();
  const r=await app.inject({method:'POST',url:'/api/channel/pairing',headers:{origin:config.publicOrigin,'x-waerp-pairing-action':'regenerate','cf-access-jwt-assertion':token()}});
  assert.equal(r.statusCode,503);assert.deepEqual(r.json(),{error:'PAIRING_CONNECT_FAILED'});assert.doesNotMatch(r.body,/PRIVATE_SESSION/);assert.equal(channel.sendCount,0);assert.deepEqual(service.database.db.prepare('select count(*) n from messages').get(),before);
 }finally{await app.close();service.database.db.close();process.env=saved}
});
