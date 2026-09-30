import { mkdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WAMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

import type { ChannelReconcileResult, ChannelSendResult, ChatPresenceState, IncomingChannelMessage, OutgoingChannelMessage, WhatsAppChannelAdapter } from './channel-contract.js';
import { validateQuotationPdfEnvelope, validateQuotationPdfAttachment } from './quotation-pdf.js';
export type { ChannelAdapter, ChannelReconcileResult, ChannelSendResult, ChatPresenceState, IncomingChannelMessage, OutgoingChannelMessage, WhatsAppChannelAdapter } from './channel-contract.js';

export type SimulatedPresenceEvent = { kind: 'available' } | { kind: 'chat'; conversationId: string; state: ChatPresenceState };

export class SimulatedChannel implements WhatsAppChannelAdapter{
  private status:'connected'|'disconnected'|'connecting'='disconnected'; private handler?: (m:IncomingChannelMessage)=>Promise<void>; private n=0;
  readonly sent:OutgoingChannelMessage[]=[]; private readonly outcomes:ChannelSendResult[]; private readonly reconcileOutcomes:ChannelReconcileResult[];
  readonly presenceEvents:SimulatedPresenceEvent[]=[];
  constructor(outcomes:ChannelSendResult[]=[],reconcileOutcomes:ChannelReconcileResult[]=[]){this.outcomes=[...outcomes];this.reconcileOutcomes=[...reconcileOutcomes]}
  get sendCount(){return this.sent.length} get clientMessageIds(){return this.sent.map(x=>x.clientMessageId)}
  async connect(){this.status='connected';await this.publishAvailable()} async disconnect(){this.status='disconnected'} async getStatus(){return this.status}
  onMessage(h:(m:IncomingChannelMessage)=>Promise<void>){this.handler=h}
  async receive(text:string, overrides:Partial<IncomingChannelMessage>={}){if(!this.handler)throw Error('NOT_CONNECTED');await this.handler({channel:'whatsapp',accountId:'demo-account',externalMessageId:`in-${++this.n}`,conversationId:'conv-001',sender:{externalId:'+6591110001',phone:'+6591110001'},type:'text',text,occurredAt:new Date().toISOString(),...overrides})}
  async send(m:OutgoingChannelMessage):Promise<ChannelSendResult>{this.sent.push(m);return this.outcomes.shift()??{status:'submitted',externalMessageId:`out-${m.clientMessageId}`,submittedAt:new Date().toISOString()}}
  async reconcile(input:{accountId:string;clientMessageId:string}){return this.reconcileOutcomes.shift()??{status:'submitted' as const,externalMessageId:`out-${input.clientMessageId}`}}
  async publishAvailable(){this.presenceEvents.push({kind:'available'})}
  async sendChatPresence(input:{conversationId:string;state:ChatPresenceState}){this.presenceEvents.push({kind:'chat',conversationId:input.conversationId,state:input.state})}
}

/** Fail-closed placeholder for configured channels without an active adapter. Presence
 * methods are intentionally omitted so callers treat it as unsupported and no-op. */
export class UnsupportedChannel implements WhatsAppChannelAdapter {
  private readonly mode: string;
  constructor(mode: string) { this.mode = mode; }
  async connect() {}
  async disconnect() {}
  async getStatus() { return 'disconnected' as const; }
  onMessage(_handler:(m:IncomingChannelMessage)=>Promise<void>) {}
  async send(_message:OutgoingChannelMessage):Promise<ChannelSendResult> { return { status:'failed', retryable:false, errorCode:`CHANNEL_ADAPTER_UNSUPPORTED:${this.mode}` }; }
  async reconcile():Promise<ChannelReconcileResult> { return { status:'unknown' }; }
  getStatusInfo() { return { status:'disconnected', mode:this.mode, adapter:'unsupported', qrReady:false, qr:null, supported:false, reason:'CHANNEL_ADAPTER_NOT_ACTIVE' }; }
}

export function normalizePhone(value:string|undefined):string|undefined{const digits=(value??'').replace(/\D/g,'');return digits?`+${digits}`:undefined}

/** Normalize Baileys provider payload into the provider-neutral contract. Groups/status/newsletters are intentionally unsupported in V1. */
export function normalizeBaileysMessage(message:WAMessage,accountId=process.env.WHATSAPP_ACCOUNT_ID??process.env.WHATSAPP_CHANNEL_ACCOUNT_ID??'demo-account'):IncomingChannelMessage|undefined{
  const key=message.key; const jid=key.remoteJid;
  if(!jid||key.fromMe||jid==='status@broadcast'||jid.endsWith('@broadcast')||jid.endsWith('@newsletter')||jid.endsWith('@g.us'))return undefined;
  const content=message.message;if(!content)return undefined;
  const directText=content.conversation??content.extendedTextMessage?.text;
  const type=directText!==undefined?'text':content.imageMessage?'image':content.audioMessage?'audio':content.documentMessage?'document':undefined;if(!type)return undefined;
  const text=directText??content.imageMessage?.caption??content.documentMessage?.caption??undefined;
  const phoneJid=jid.endsWith('@lid')&&key.remoteJidAlt?.endsWith('@s.whatsapp.net')?key.remoteJidAlt:jid;
  const phone=phoneJid.endsWith('@s.whatsapp.net')?normalizePhone(phoneJid.split('@')[0].replace(/:\d+$/,'')):undefined;
  const context=content.extendedTextMessage?.contextInfo??content.imageMessage?.contextInfo??content.videoMessage?.contextInfo??content.documentMessage?.contextInfo;
  const isForwarded=Boolean(context?.isForwarded)||Number(context?.forwardingScore??0)>0;
  const originalSender=context?.participant??undefined;
  const rawTimestamp=Number(message.messageTimestamp); const timestamp=Number.isFinite(rawTimestamp)&&rawTimestamp>0?(rawTimestamp>1e12?rawTimestamp:rawTimestamp*1000):Date.now();
  const media=type==='image'?{mimeType:content.imageMessage?.mimetype??'application/octet-stream',externalRef:`baileys:${key.id??timestamp}`}:type==='audio'?{mimeType:content.audioMessage?.mimetype??'application/octet-stream',externalRef:`baileys:${key.id??timestamp}`}:type==='document'?{mimeType:content.documentMessage?.mimetype??'application/octet-stream',externalRef:`baileys:${key.id??timestamp}`}:undefined;
  return {channel:'whatsapp',accountId,externalMessageId:key.id??`baileys-${timestamp}`,conversationId:jid,sender:{externalId:jid,phone},type,text:text??undefined,media,occurredAt:new Date(timestamp).toISOString(),replyToExternalMessageId:context?.stanzaId??undefined,forwarding:isForwarded?{isForwarded:true,originalSenderKnown:Boolean(originalSender),originalSenderExternalId:originalSender}:undefined};
}

/** Demo-only/unofficial linked-device adapter. Production migration uses a Meta adapter behind the same interface. */
type BaileysSocket=ReturnType<typeof makeWASocket>;
type BaileysSocketFactory=(config:Parameters<typeof makeWASocket>[0])=>BaileysSocket;

export class QrDemoAdapter implements WhatsAppChannelAdapter{
  readonly unofficial=true; private status:'connected'|'disconnected'|'connecting'='disconnected'; private handler?: (m:IncomingChannelMessage)=>Promise<void>;
  private socket?:BaileysSocket; private qr?:string; private reconnects=0; private connecting?:Promise<void>; private reconnectTimer?:ReturnType<typeof setTimeout>; private stopping=false;
  constructor(private readonly authDir=process.env.WHATSAPP_AUTH_DIR??'.data/whatsapp-auth',private readonly accountId=process.env.WHATSAPP_ACCOUNT_ID??process.env.WHATSAPP_CHANNEL_ACCOUNT_ID??'demo-account',private readonly socketFactory:BaileysSocketFactory=makeWASocket){}
  async connect(){if(this.status==='connected')return;if(this.connecting)return this.connecting;this.stopping=false;this.connecting=this.open();try{await this.connecting}finally{this.connecting=undefined}}
  private async open(){this.status='connecting';await mkdir(this.authDir,{recursive:true});const {state,saveCreds}=await useMultiFileAuthState(this.authDir);if(this.stopping)return;const socket=this.socketFactory({auth:state});this.socket=socket;
    socket.ev.on('creds.update',saveCreds);
    socket.ev.on('connection.update',async update=>{if(socket!==this.socket)return;if(update.qr)this.qr=await QRCode.toDataURL(update.qr);if(update.connection==='open'){this.qr=undefined;this.status='connected';this.reconnects=0;await this.publishAvailable()}if(update.connection==='close'){this.socket=undefined;this.status='disconnected';const code=(update.lastDisconnect?.error as any)?.output?.statusCode;if(code===DisconnectReason.loggedOut){this.qr=undefined;return}if(!this.stopping&&this.reconnects<5){const delay=Math.min(1000*2**this.reconnects++,16000);if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=undefined;void this.connect()},delay)}}});
    socket.ev.on('messages.upsert',async({type,messages})=>{if(type!=='notify'||socket!==this.socket)return;for(const raw of messages){const normalized=normalizeBaileysMessage(raw,this.accountId);if(normalized&&this.handler)await this.handler(normalized)}})
  }
  async disconnect(){this.stopping=true;if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=undefined}const socket=this.socket;this.socket=undefined;this.qr=undefined;this.status='disconnected';socket?.end(undefined)}
  async getStatus(){return this.status}
  getStatusInfo(){return {status:this.status,mode:'whatsapp-qr',adapter:'WhatsAppChannelAdapter',qrReady:Boolean(this.qr),qr:this.qr??null,unofficial:true,accountId:this.accountId}}
  onMessage(handler:(message:IncomingChannelMessage)=>Promise<void>){this.handler=handler}
  async send(message:OutgoingChannelMessage):Promise<ChannelSendResult>{if(!this.socket)return{status:'unknown',clientMessageId:message.clientMessageId};try{validateQuotationPdfEnvelope(message);const attachment=message.attachments?.[0];if(!attachment)return this.submitText(message);const validated=validateQuotationPdfAttachment(attachment);const bytes=Buffer.from(validated.ref.slice('data:application/pdf;base64,'.length),'base64');const sent=await this.socket.sendMessage(message.conversationId,{document:bytes,fileName:validated.fileName,mimetype:validated.mimeType,caption:message.text});return{status:'submitted',externalMessageId:sent?.key.id??`qr-${message.clientMessageId}`,submittedAt:new Date().toISOString()}}catch(error){return{status:'failed',retryable:false,errorCode:(error as Error).message}}}
  private async submitText(message:OutgoingChannelMessage):Promise<ChannelSendResult>{const sent=await this.socket!.sendMessage(message.conversationId,{text:message.text});return{status:'submitted',externalMessageId:sent?.key.id??`qr-${message.clientMessageId}`,submittedAt:new Date().toISOString()}}
  async reconcile(){return{status:'unknown' as const}}
  /** Best-effort transport UX. Baileys presence calls never affect message delivery. */
  async publishAvailable(){if(!this.socket)return;try{await this.socket.sendPresenceUpdate('available')}catch{/* presence is UX-only */}}
  async sendChatPresence(input:{conversationId:string;state:ChatPresenceState}){if(!this.socket)return;try{await this.socket.sendPresenceUpdate(input.state,input.conversationId)}catch{/* presence is UX-only */}}
}

/** Future official Meta adapter must implement the provider-neutral ChannelAdapter contract. No runtime placeholder is exported in Phase 0. */
