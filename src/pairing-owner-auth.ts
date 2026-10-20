import {createPublicKey,verify,type JsonWebKey} from 'node:crypto';

export type PairingOwnerControl={publicOrigin:string;verifyOwner:(assertion:string)=>Promise<boolean>};
type Config={issuer:string;audience:string;ownerEmail:string;publicOrigin:string};
type Jwk=JsonWebKey & {kid?:string;alg?:string;use?:string};
/** Existing Access session only. No token storage, identity-header trust, staff grant or credential creation. */
export function createPairingOwnerControl(config:Config,loadKeys?:()=>Promise<Jwk[]>):PairingOwnerControl {
 const issuer=new URL(config.issuer);const origin=new URL(config.publicOrigin);
 if(issuer.protocol!=='https:'||!issuer.hostname.endsWith('.cloudflareaccess.com')||issuer.pathname!=='/'||origin.protocol!=='https:'||origin.origin!==config.publicOrigin||!config.audience||!config.ownerEmail)throw Error('INVALID_PAIRING_ACCESS_CONFIG');
 let keys:Jwk[]=[];let expires=0;let loading:Promise<Jwk[]>|undefined;
 const getKeys=async()=>{
  if(Date.now()<expires)return keys;
  loading??=(async()=>{const found=loadKeys?await loadKeys():await fetch(new URL('/cdn-cgi/access/certs',issuer),{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('CERTS_UNAVAILABLE');return (await r.json() as {keys:Jwk[]}).keys});if(!Array.isArray(found))throw Error('CERTS_UNAVAILABLE');keys=found;expires=Date.now()+60_000;return keys})();
  try{return await loading}finally{loading=undefined}
 };
 return {publicOrigin:config.publicOrigin,verifyOwner:async assertion=>{
  try{
   if(!assertion||assertion.length>16384)return false;
   const parts=assertion.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))return false;
   const header=JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());const claims=JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
   const now=Date.now()/1000;
   if(header.alg!=='RS256'||typeof header.kid!=='string'||claims.iss!==issuer.origin||claims.type!=='app'||typeof claims.email!=='string'||claims.email.toLowerCase()!==config.ownerEmail.toLowerCase()||!Number.isFinite(claims.exp)||claims.exp<=now||(claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now))||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes(config.audience))return false;
   const jwk=(await getKeys()).find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256'&&k.use==='sig');if(!jwk)return false;
   return verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2]!, 'base64url'));
  }catch{return false}
 }};
}
export function pairingOwnerControlFromEnv():PairingOwnerControl|undefined {
 const issuer=process.env.PAIRING_ACCESS_ISSUER,audience=process.env.PAIRING_ACCESS_AUDIENCE,ownerEmail=process.env.PAIRING_OWNER_EMAIL,publicOrigin=process.env.PAIRING_PUBLIC_ORIGIN;
 if(!issuer||!audience||!ownerEmail||!publicOrigin)return undefined;
 return createPairingOwnerControl({issuer,audience,ownerEmail,publicOrigin});
}
