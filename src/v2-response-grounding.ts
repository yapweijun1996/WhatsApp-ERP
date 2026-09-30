/** GROUND-001 only: canonical, transport-independent response authorization. */
import {createHash,randomUUID} from 'node:crypto';
import {V1Database} from './database.js';
import {quotationCommercialSealPayload} from './commerce.js';
import {buildGroundingReferenceProjection} from './v2-grounding-references.js';
import {validateGroundedResponsePlan,PROTECTED_FACT_SLOTS,type GroundedResponsePlan,type ProtectedFactSlot} from './v2-grounded-response-plan.js';
type Ref=GroundedResponsePlan['factClaims'][number]['canonicalRef'];
export type GroundingFact=Readonly<{slot:ProtectedFactSlot;value:string|number|boolean;canonicalRef:Ref}>;
export type GroundingVerdict=Readonly<{turnId:string;verdict:'PASS'|'REJECT';intent:GroundedResponsePlan['intent'];outboundPurpose:GroundedResponsePlan['outboundPurpose'];safeConnectiveText:string;factSlots:readonly GroundingFact[];renderedSegments:readonly Readonly<{kind:'CONNECTIVE'|'FACT';text:string;slot?:ProtectedFactSlot}>[];renderedText:string;safeReasonCode?:string;handoff?:GroundedResponsePlan['handoff'];rejectionReason?:string;verifiedAt:string}>;
export type RenderableGroundedResponse=GroundingVerdict;
export type HistoricalGroundingEvidence=Readonly<GroundingVerdict & {authorizationStatus:'HISTORICAL_READ_ONLY';canAuthorize:false}>;
const freshAuthorizationToken=Symbol('fresh-grounding-authorization');
const freshAuthorizations=new WeakSet<object>();
export type FreshGroundingAuthorization=Readonly<{readonly [freshAuthorizationToken]:true;readonly verdict:GroundingVerdict;readonly authorizationStatus:'FRESH_ONLY';readonly canAuthorize:true}>;
export function isFreshGroundingAuthorization(value:unknown):value is FreshGroundingAuthorization{return typeof value==='object'&&value!==null&&freshAuthorizations.has(value)}
const REASONS=new Set(['GROUNDING_SCOPE','GROUNDING_SOURCE','GROUNDING_STALE','GROUNDING_UNSUPPORTED','GROUNDING_CONTRADICTION','GROUNDING_MISSING_EVIDENCE','GROUNDING_INJECTION','GROUNDING_CANONICAL_MISMATCH','GROUNDING_LEDGER_CONFLICT']);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const fail=(code:string):never=>{throw Error(`GROUNDING_INVALID:${code}`)};
const parse=(s:unknown,code:string):any=>{if(typeof s!=='string')fail(code);try{return JSON.parse(String(s))}catch{fail(code)}};
const freeze=<T>(v:T):T=>{const copy=JSON.parse(JSON.stringify(v));const walk=(x:any):any=>{if(x&&typeof x==='object'){for(const y of Object.values(x))walk(y);Object.freeze(x)}return x};return walk(copy)};
const all=(db:any,sql:string,...args:any[])=>db.prepare(sql).all(...args);
type MutationState={depth:number};
const mutationStates=new WeakMap<object,MutationState>();
function installMutationGuard(db:V1Database['db']){let state=mutationStates.get(db as object);if(!state){state={depth:0};mutationStates.set(db as object,state)}db.function('v2_response_grounding_mutation_authorized',()=>state!.depth>0?1:0)}
function decimal(value:unknown,code:string):{n:bigint;scale:number}{const s=String(value);if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s))fail(code);const [a,b='']=s.split('.');return {n:BigInt(a+b),scale:b.length}}
function decimalProduct(a:unknown,b:unknown,code:string){const x=decimal(a,code),y=decimal(b,code);return {n:x.n*y.n,scale:x.scale+y.scale}}
function decimalGte(a:unknown,b:unknown,code:string){const x=decimal(a,code),y=decimal(b,code),scale=Math.max(x.scale,y.scale);return x.n*10n**BigInt(scale-x.scale)>=y.n*10n**BigInt(scale-y.scale)}
function decimalString(v:{n:bigint;scale:number}){if(v.scale===0)return v.n.toString();const neg=v.n<0n?'−':'';const raw=(v.n<0n?-v.n:v.n).toString().padStart(v.scale+1,'0');return `${neg}${raw.slice(0,-v.scale)}.${raw.slice(-v.scale)}`.replace(/\.0+$/,'')}
function moneyTotal(quantity:unknown,cents:unknown){const q=decimal(quantity,'GROUNDING_DECIMAL'),c=decimal(cents,'GROUNDING_DECIMAL');const raw=decimalString({n:q.n*c.n,scale:q.scale+c.scale+2});return raw.includes('.')?raw.padEnd(raw.indexOf('.')+3,'0'):`${raw}.00`}
function exactCents(quantity:unknown,unitPriceCents:unknown){const product=decimalProduct(quantity,unitPriceCents,'GROUNDING_DECIMAL');if(product.scale>0&&product.n%10n**BigInt(product.scale)!==0n)throw Error('GROUNDING_FRACTIONAL_CENT');const cents=product.n/10n**BigInt(product.scale);if(cents<0n||cents>2147483647n)throw Error('GROUNDING_MONEY_RANGE');return cents}
function centsText(cents:unknown){if(typeof cents!=='number'||!Number.isSafeInteger(cents)||cents<0)throw Error('GROUNDING_MONEY_RANGE');return `${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`}
const evidenceSlots:Record<string,ReadonlySet<string>>={product_resolution:new Set(['product']),uom_resolution:new Set(['uom']),uom_conversion:new Set(['uom']),customer_price:new Set(['price','currency','total']),warehouse_stock:new Set(['stock','availability']),customer_eligibility:new Set(['customer_identity','currency']),draft_delivery:new Set(['delivery_date','date']),order_history:new Set()};
export class ResponseGroundingGuard{
 constructor(private readonly database:V1Database){installMutationGuard(database.db)}
 readLatest(turnId:string):HistoricalGroundingEvidence|null{const row=this.readRow(this.database.db.prepare('SELECT verdict_json,verdict_hash FROM grounding_verdicts WHERE turn_id=? ORDER BY sequence DESC LIMIT 1').get(turnId) as any);return row?freeze({...row,authorizationStatus:'HISTORICAL_READ_ONLY' as const,canAuthorize:false as const}):null}
 /** Historical readback only; never fresh authorization. */ read(turnId:string){return this.readLatest(turnId)}
 history(turnId:string):HistoricalGroundingEvidence[]{return (this.database.db.prepare('SELECT verdict_json,verdict_hash FROM grounding_verdicts WHERE turn_id=? ORDER BY sequence').all(turnId) as any[]).map(x=>this.readRow(x)!).filter(Boolean).map(row=>freeze({...row,authorizationStatus:'HISTORICAL_READ_ONLY' as const,canAuthorize:false as const}))}
 /** Produces the only artifact an eventual outbound owner may consume. It always recomputes and appends. */
 authorize(turnId:string,suppliedPlan?:unknown):FreshGroundingAuthorization{const verdict=this.ground(turnId,suppliedPlan);if(verdict.verdict!=='PASS')throw Error(`GROUNDING_NOT_AUTHORIZED:${verdict.rejectionReason??'REJECTED'}`);const artifact=Object.freeze({[freshAuthorizationToken]:true as const,verdict,authorizationStatus:'FRESH_ONLY' as const,canAuthorize:true as const});freshAuthorizations.add(artifact);return artifact}
 ground(turnId:string,suppliedPlan?:unknown){
  if(typeof turnId!=='string'||!turnId.trim())fail('TURN_ID');const db=this.database.db,turn=db.prepare('SELECT * FROM agent_turns WHERE id=?').get(turnId) as any;if(!turn)fail('TURN_NOT_FOUND');
  const stored=db.prepare('SELECT plan_json,plan_hash FROM agent_response_plans WHERE turn_id=?').get(turnId) as any;if(!stored||hash(stored.plan_json)!==stored.plan_hash)fail('PLAN_INTEGRITY');const plan=validateGroundedResponsePlan(suppliedPlan===undefined?parse(stored.plan_json,'PLAN_MISSING'):suppliedPlan,turnId);if(suppliedPlan!==undefined&&JSON.stringify(plan)!==stored.plan_json)fail('PLAN_REPLAY_CONFLICT');
  return this.#mutate(()=>{const authority=this.authority(turn,stored.plan_hash,plan),fingerprint=hash(JSON.stringify(authority));const verdict=this.compute(turn,plan,authority),text=JSON.stringify(verdict),sequence=Number((db.prepare('SELECT COALESCE(MAX(sequence),0) n FROM grounding_verdicts WHERE turn_id=?').get(turnId) as any).n)+1;db.prepare('INSERT INTO grounding_verdicts(id,turn_id,sequence,plan_hash,authority_fingerprint,verdict,verdict_json,verdict_hash,verified_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),turnId,sequence,stored.plan_hash,fingerprint,verdict.verdict,text,hash(text),verdict.verifiedAt);return verdict});
 }
 execute(turnId:string){return this.ground(turnId)}
 private readRow(row:any):GroundingVerdict|null{if(!row)return null;if(typeof row.verdict_json!=='string'||hash(String(row.verdict_json))!==row.verdict_hash)fail('LEDGER_INTEGRITY');const x=parse(row.verdict_json,'LEDGER_JSON');if(!x||!['PASS','REJECT'].includes(x.verdict)||!Array.isArray(x.factSlots)||typeof x.renderedText!=='string'||x.renderedText.length>12000)fail('LEDGER_STRUCTURE');return freeze(x)}
 private authority(turn:any,planHash:string,plan:GroundedResponsePlan){const db=this.database.db,conv=db.prepare('SELECT id,customer_id,channel_account_id FROM conversations WHERE id=? AND channel_account_id=?').get(turn.conversation_id,turn.account_id) as any;const customer=conv?db.prepare('SELECT id,code,name,currency,credit_status,default_warehouse_id FROM customers WHERE id=?').get(conv.customer_id):null;const drafts=all(db,'SELECT id,current_revision,requested_delivery_date,warehouse_id,currency,customer_id FROM order_drafts WHERE account_id=? AND conversation_id=? AND customer_id=? ORDER BY id',turn.account_id,turn.conversation_id,conv?.customer_id);const refs=plan.factClaims.map(c=>c.canonicalRef.sourceId);const evidence=refs.length?all(db,`SELECT id,evidence_type,source_version,observed_at FROM erp_evidence WHERE id IN (${refs.map(()=>'?').join(',')})`,...refs):[];return {turn:{id:turn.id,conversationId:turn.conversation_id,accountId:turn.account_id,inbound:turn.inbound_message_id},planHash,slots:plan.factClaims.map(c=>c.slot),conv,customer,drafts,evidence,prices:all(db,'SELECT id,customer_id,product_id,uom,unit_price_cents,currency,valid_from,valid_to FROM customer_prices WHERE customer_id=? ORDER BY id',conv?.customer_id),stock:true?all(db,'SELECT product_id,warehouse_id,quantity_base FROM stock_balances WHERE warehouse_id IN (SELECT warehouse_id FROM order_drafts WHERE id=?) ORDER BY product_id,warehouse_id',drafts[0]?.id):[],quotes:all(db,'SELECT * FROM quotations WHERE source_conversation_id=? AND customer_id=? ORDER BY id',turn.conversation_id,conv?.customer_id),acceptance:all(db,'SELECT a.* FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE q.source_conversation_id=? AND q.customer_id=? ORDER BY a.id',turn.conversation_id,conv?.customer_id),salesOrders:all(db,'SELECT s.* FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE q.source_conversation_id=? AND q.customer_id=? ORDER BY s.id',turn.conversation_id,conv?.customer_id)} }
 #mutate<T>(operation:()=>T):T{const authorized=mutationStates.get(this.database.db as object) as MutationState; if(!authorized)fail('MUTATION_GUARD'); authorized.depth++; try{return this.database.db.transaction(operation)()}finally{authorized.depth--;}}
  private compute(turn:any,plan:GroundedResponsePlan,authority:any){const now=new Date().toISOString(),base:any={turnId:turn.id,verdict:'PASS',intent:plan.intent,outboundPurpose:plan.outboundPurpose,safeConnectiveText:plan.connectiveText??'',factSlots:[],renderedSegments:[],renderedText:'',verifiedAt:now};try{const db=this.database.db,conv=authority.conv;if(!conv||!db.prepare("SELECT 1 FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(turn.inbound_message_id,turn.account_id,turn.conversation_id))throw Error('GROUNDING_SCOPE');this.rejectConnectiveLeak(base.safeConnectiveText,authority,turn);const exposed=this.exposed(turn),seen=new Set<string>();for(const claim of plan.factClaims){if(seen.has(claim.slot))throw Error('GROUNDING_CONTRADICTION');seen.add(claim.slot);const key=`${claim.canonicalRef.sourceId}|${claim.canonicalRef.versionOrRevision}|${[...claim.canonicalRef.evidenceRefs].sort().join(',')}`;if(!exposed.has(key))throw Error('GROUNDING_SOURCE');base.factSlots.push(this.resolve(turn,conv,claim));}base.renderedSegments=[{kind:'CONNECTIVE',text:base.safeConnectiveText},...base.factSlots.map((f:any)=>({kind:'FACT',slot:f.slot,text:String(f.value)}))];base.renderedText=base.renderedSegments.map((x:any)=>x.text).join(' ');if(base.renderedText.length>12000)throw Error('GROUNDING_CANONICAL_MISMATCH');return freeze(base)}catch(e){const code=String((e as Error).message);return freeze({turnId:turn.id,verdict:'REJECT',intent:plan.intent,outboundPurpose:plan.outboundPurpose,safeConnectiveText:'',factSlots:[],renderedSegments:[],renderedText:'',safeReasonCode:'GROUNDING_REJECTED',rejectionReason:REASONS.has(code)?code:'GROUNDING_CANONICAL_MISMATCH',verifiedAt:now})}}
  private rejectConnectiveLeak(text:string,authority:any,turn:any){
   if(!text)return;
   const values:string[]=[];const collect=(v:any)=>{if(v===null||v===undefined)return;if(typeof v==='string'||typeof v==='number')values.push(String(v));else if(Array.isArray(v))v.forEach(collect);else if(typeof v==='object')Object.values(v).forEach(collect)};
   collect(authority.customer);collect(authority.drafts);collect(authority.prices);collect(authority.stock);collect(authority.quotes);collect(authority.acceptance);collect(authority.salesOrders);
   const db=this.database.db;collect(db.prepare('SELECT stock_code,description,base_uom FROM products WHERE active=1').all());collect(db.prepare('SELECT code FROM uoms').all());
   for(const price of authority.prices??[])if(typeof price.unit_price_cents==='number')values.push(centsText(price.unit_price_cents));
    const projection=buildGroundingReferenceProjection(this.database.db,turn.account_id,turn.conversation_id,[],turn.id);projection.descriptors.forEach(x=>values.push(x));projection.references.forEach(x=>{values.push(x.sourceId,x.versionOrRevision,...x.evidenceRefs)});
   const literals=[...new Set(values.filter(x=>x.length>0))].sort((a,b)=>b.length-a.length);
   for(const value of literals){const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const numeric=/^\d+(?:\.\d+)?$/.test(value);const shortToken=/^[A-Za-z0-9_-]{1,3}$/.test(value);const pattern=numeric?new RegExp(`(?:^|\\s|[(:/])${escaped}(?=$|\\s|[),.!?:/])`,'i'):shortToken?new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`,'i'):new RegExp(escaped,'i');if(pattern.test(text))throw Error('GROUNDING_CANONICAL_MISMATCH');}
  }
  private exposed(turn:any){const actions=this.database.db.prepare('SELECT a.id,a.turn_id AS turnId,a.sequence,a.capability_name AS capabilityName,a.capability_version AS capabilityVersion,a.arguments_json AS arguments,r.result_json AS result FROM agent_actions a JOIN agent_action_results r ON r.action_id=a.id WHERE a.turn_id=? ORDER BY a.sequence').all(turn.id) as any[];const refs=buildGroundingReferenceProjection(this.database.db,turn.account_id,turn.conversation_id,actions.map(a=>({id:a.id,turnId:a.turnId,sequence:a.sequence,capability:{name:a.capabilityName,version:a.capabilityVersion},arguments:parse(a.arguments,'ACTION_ARGUMENTS'),result:parse(a.result,'ACTION_RESULT')})),turn.id);return new Set(refs.references.map(r=>`${r.sourceId}|${r.versionOrRevision}|${[...r.evidenceRefs].sort().join(',')}`))}
  private validationEvidence(turn:any,conv:any,claim:any){
  const db=this.database.db,id=claim.canonicalRef.sourceId;
  const evidence=db.prepare('SELECT * FROM erp_evidence WHERE id=?').get(id) as any;
   if(!evidence||evidence.source_version!==claim.canonicalRef.versionOrRevision)throw Error('GROUNDING_STALE');
  if(!evidenceSlots[evidence.evidence_type]?.has(claim.slot))throw Error('GROUNDING_UNSUPPORTED');
   const d=db.prepare("SELECT * FROM order_drafts WHERE account_id=? AND conversation_id=? AND customer_id=? AND status='CURRENT'").get(turn.account_id,turn.conversation_id,conv.customer_id) as any;
  if(!d)throw Error('GROUNDING_SCOPE');
   const rows=db.prepare("SELECT v.*,p.evidence_id provenance_evidence FROM v2_order_validations v JOIN grounding_provenance_links p ON p.draft_id=v.draft_id AND p.draft_revision=v.draft_revision AND p.evidence_id=? WHERE v.draft_id=? AND v.draft_revision=? AND v.mode='DRAFT' AND v.status='SUCCEEDED' ORDER BY v.rowid DESC").all(id,d.id,d.current_revision) as any[];
  for(const row of rows){
   const rawRefs=parse(row.evidence_refs_json,'VALIDATION_EVIDENCE');
   const refs=Array.isArray(rawRefs)?rawRefs.map((x:any)=>typeof x==='string'?x:x?.sourceId).filter((x:any):x is string=>typeof x==='string'):[];
   if(refs.length!==rawRefs.length||!refs.includes(id)||claim.canonicalRef.evidenceRefs.some((x:string)=>!refs.includes(x)))continue;
   const result=parse(row.result_json,'VALIDATION_RESULT');
   const validationData=result?.data??result;
   const lines=Array.isArray(validationData?.lines)?validationData.lines:[];
   const revision=db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(d.id,d.current_revision) as any;
   const snapshot=parse(revision?.immutable_snapshot_json,'DRAFT_SNAPSHOT');
   this.verifyWholeValidation(turn,conv,d,result,snapshot,refs);
   const line=lines.find((x:any)=>Array.isArray(x.evidenceRefs)&&x.evidenceRefs.includes(id))??(evidence.evidence_type==='draft_delivery'?lines[0]:undefined);
   return {evidence,result,line,draft:d};
  }
  throw Error('GROUNDING_MISSING_EVIDENCE');
 }
 private verifyWholeValidation(turn:any,conv:any,draft:any,result:any,snapshot:any,validationRefs:any[]){
 const db=this.database.db, data=result?.data??result, historical=Array.isArray(data?.lines)?data.lines:[], requested=Array.isArray(snapshot?.lines)?snapshot.lines:[];
  if((result?.status??'SUCCEEDED')!=='SUCCEEDED'||data?.draftId!==draft.id||data?.draftRevision!==draft.current_revision||historical.length!==requested.length||snapshot.requestedDeliveryDate!==draft.requested_delivery_date||snapshot.warehouseId!==draft.warehouse_id||snapshot.currency!==draft.currency)throw Error('GROUNDING_STALE');
  const customer=db.prepare('SELECT id,code,name,currency,credit_status,default_warehouse_id FROM customers WHERE id=?').get(conv.customer_id) as any;
  const validatedCustomer=data?.customer;
  if(!customer||!validatedCustomer||validatedCustomer.id!==customer.id||validatedCustomer.code!==customer.code||validatedCustomer.name!==customer.name||validatedCustomer.currency!==customer.currency||validatedCustomer.creditStatus!==customer.credit_status||validatedCustomer.warehouseId!==customer.default_warehouse_id||data.currency!==customer.currency||data.warehouseId!==draft.warehouse_id)throw Error('GROUNDING_STALE');
  const allRefs=new Set(validationRefs);let total=0n,subtotal=0n;
  for(const req of requested){
   const line=historical.find((x:any)=>x.lineNo===req.line_no);if(!line||line.requestedWording!==req.requested_wording||String(line.quantity)!==String(req.quantity)||String(line.requestedUom).toUpperCase()!==String(req.requested_uom).toUpperCase()||!line.productId||!line.stockCode||!line.baseUom||!line.baseQuantity||!Number.isSafeInteger(line.unitPriceCents)||!Number.isSafeInteger(line.subtotalCents))throw Error('GROUNDING_MISSING_EVIDENCE');
   const matches=db.prepare(`SELECT DISTINCT p.* FROM products p LEFT JOIN product_aliases a ON a.product_id=p.id AND a.customer_id=? WHERE p.active=1 AND (lower(p.stock_code)=lower(?) OR lower(a.alias)=lower(?) OR lower(p.description)=lower(?)) ORDER BY p.id`).all(conv.customer_id,req.requested_wording,req.requested_wording,req.requested_wording) as any[];
   const product=matches.length===1?matches[0]:null;if(!product||line.productId!==product.id||line.stockCode!==product.stock_code||String(line.baseUom).toUpperCase()!==String(product.base_uom).toUpperCase())throw Error('GROUNDING_STALE');
   const uom=String(req.requested_uom).toUpperCase(),conversion=product.base_uom===uom?'1':(db.prepare('SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=? AND to_uom=? ORDER BY id').all(product.id,uom,product.base_uom) as any[]);if(Array.isArray(conversion)&&conversion.length!==1)throw Error('GROUNDING_STALE');const factor=Array.isArray(conversion)?conversion[0].factor:conversion;
   const price=db.prepare('SELECT unit_price_cents,currency FROM customer_prices WHERE customer_id=? AND product_id=? AND uom=? AND valid_from<=date(?) AND (valid_to IS NULL OR valid_to>=date(?)) ORDER BY valid_from DESC,id DESC').all(conv.customer_id,product.id,uom,new Date().toISOString(),new Date().toISOString()) as any[];
   const stock=db.prepare('SELECT quantity_base FROM stock_balances WHERE product_id=? AND warehouse_id=?').get(product.id,snapshot.warehouseId??draft.warehouse_id) as any;
   if(!factor||price.length!==1||!stock||line.unitPriceCents!==price[0].unit_price_cents||line.currency!==price[0].currency||line.availableBaseQuantity!==String(stock.quantity_base)||line.baseQuantity!==decimalString(decimalProduct(String(req.quantity),String(factor),'GROUNDING_DECIMAL')))throw Error('GROUNDING_STALE');
   if(!decimalGte(String(stock.quantity_base),decimalString(decimalProduct(String(req.quantity),String(factor),'GROUNDING_DECIMAL')),'GROUNDING_DECIMAL'))throw Error('GROUNDING_STALE');
   if(!Array.isArray(line.evidenceRefs)||line.evidenceRefs.length===0||line.evidenceRefs.some((x:string)=>!allRefs.has(x)))throw Error('GROUNDING_MISSING_EVIDENCE');
   const exact=exactCents(String(req.quantity),price[0].unit_price_cents);if(BigInt(line.subtotalCents)!==exact)throw Error('GROUNDING_FRACTIONAL_CENT');total+=exact;subtotal+=BigInt(line.subtotalCents);
  }
  if(!Number.isSafeInteger(data.subtotalCents)||!Number.isSafeInteger(data.grandTotalCents)||!Number.isSafeInteger(data.taxCents)||BigInt(data.subtotalCents)!==subtotal||BigInt(data.grandTotalCents)!==total||data.taxCents!==0)throw Error('GROUNDING_STALE');
 }
 private resolve(turn:any,conv:any,claim:any):GroundingFact{
  const {slot,canonicalRef:r}=claim,db=this.database.db,id=r.sourceId;
  if(slot==='current_order_draft_items'){
   if(r.versionOrRevision.indexOf('revision:')!==0||id.indexOf('draft:')!==0||r.evidenceRefs.length!==1||r.evidenceRefs[0]!==`${id}:${r.versionOrRevision}`)throw Error('GROUNDING_STALE');
   const draftId=id.slice('draft:'.length),revision=Number(r.versionOrRevision.slice('revision:'.length));
   const draft=db.prepare("SELECT id,current_revision FROM order_drafts WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=? AND status='CURRENT'").get(draftId,turn.account_id,turn.conversation_id,conv.customer_id) as any;
   if(!draft||draft.current_revision!==revision)throw Error('GROUNDING_STALE');
   const lines=db.prepare('SELECT line_no,requested_wording,quantity,requested_uom FROM order_draft_lines WHERE draft_id=? ORDER BY line_no').all(draft.id) as any[];
   if(!lines.length)throw Error('GROUNDING_MISSING_EVIDENCE');
   const value=lines.map(line=>`${line.line_no}. ${line.requested_wording} — ${String(line.quantity)} ${line.requested_uom}`).join('\n');
   return {slot,value,canonicalRef:r};
  }
  const customer=db.prepare('SELECT id,name FROM customers WHERE id=?').get(conv.customer_id) as any;
  if(slot==='customer_identity'){
   if(!customer||id!==customer.id||r.versionOrRevision!==`customer:${customer.id}`)throw Error('GROUNDING_STALE');
   return {slot,value:customer.name,canonicalRef:r};
  }
 const quote=db.prepare('SELECT * FROM quotations WHERE (id=? OR quotation_no=?) AND source_conversation_id=? AND customer_id=?').get(id,id,turn.conversation_id,conv.customer_id) as any;
  if(quote){this.verifyQuotation(quote,turn,conv);if(r.versionOrRevision!==`quote:${quote.id}:${quote.status}`)throw Error('GROUNDING_STALE');const value=({quotation_reference:quote.id,quotation_number:quote.quotation_no,quotation_status:quote.status,total:centsText(quote.grand_total_cents),currency:quote.currency,delivery_date:quote.delivery_date,date:quote.quotation_date} as Record<string,any>)[slot];if(value===undefined)throw Error('GROUNDING_UNSUPPORTED');return {slot,value:String(value),canonicalRef:r};}
  const acceptance=db.prepare('SELECT a.*,q.status quotation_status FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE a.id=? AND q.source_conversation_id=? AND q.customer_id=?').get(id,turn.conversation_id,conv.customer_id) as any;
  if(acceptance){const acceptedQuote=db.prepare('SELECT * FROM quotations WHERE id=?').get(acceptance.quotation_id) as any;this.verifyQuotation(acceptedQuote,turn,conv);if(slot!=='commitment_outcome'||r.versionOrRevision!==`acceptance:${acceptance.id}:${acceptance.quotation_status}`||acceptance.quotation_status!=='ACCEPTED')throw Error('GROUNDING_STALE');this.verifyAcceptance(acceptance,acceptedQuote,turn,conv);return {slot,value:'ACCEPTED',canonicalRef:r};}
  const so=db.prepare('SELECT s.* FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE (s.id=? OR s.sales_order_no=?) AND q.source_conversation_id=? AND q.customer_id=?').get(id,id,turn.conversation_id,conv.customer_id) as any;
  if(so){const quoteForSo=db.prepare('SELECT * FROM quotations WHERE id=?').get(so.source_quotation_id) as any;this.verifyQuotation(quoteForSo,turn,conv);const accepted=db.prepare('SELECT * FROM quotation_acceptances WHERE quotation_id=?').get(so.source_quotation_id) as any;if(!accepted||quoteForSo.status!=='ACCEPTED'||so.source_acceptance_message_id!==accepted.message_id)throw Error('GROUNDING_STALE');this.verifyAcceptance(accepted,quoteForSo,turn,conv);this.verifySalesOrder(so,quoteForSo);if(r.versionOrRevision!==`so:${so.id}:${so.status}`)throw Error('GROUNDING_STALE');const value=({sales_order_number:so.sales_order_no,sales_order_status:so.status,total:centsText(so.grand_total_cents),currency:so.currency,delivery_date:so.delivery_date} as Record<string,any>)[slot];if(value===undefined)throw Error('GROUNDING_UNSUPPORTED');return {slot,value:String(value),canonicalRef:r};}
  const {result,line,draft}=this.validationEvidence(turn,conv,claim);
  const snap=parse((db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(draft.id,draft.current_revision) as any)?.immutable_snapshot_json,'DRAFT_SNAPSHOT');
  if(!line)throw Error('GROUNDING_UNSUPPORTED');
  const productKey=line.productId??line.stockCode;const product=db.prepare('SELECT * FROM products WHERE (id=? OR stock_code=?) AND active=1').get(productKey,productKey) as any;if(!product)throw Error('GROUNDING_STALE');
  const uom=String(line.requestedUom).toUpperCase(),qty=String(line.quantity),warehouse=snap.warehouseId??draft.warehouse_id;
  const price=db.prepare('SELECT unit_price_cents,currency FROM customer_prices WHERE customer_id=? AND product_id=? AND uom=? AND valid_from<=date(?) AND (valid_to IS NULL OR valid_to>=date(?)) ORDER BY valid_from DESC,id DESC').all(conv.customer_id,product.id,uom,new Date().toISOString(),new Date().toISOString()) as any[];
  const stock=db.prepare('SELECT quantity_base FROM stock_balances WHERE product_id=? AND warehouse_id=?').get(product.id,warehouse) as any;
  const conversions=product.base_uom===uom?[{factor:'1'}]:all(db,'SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=? AND to_uom=?',product.id,uom,product.base_uom);
  if(price.length!==1||!stock||conversions.length!==1)throw Error('GROUNDING_STALE');
  const p=price[0],required=decimalProduct(qty,conversions[0].factor,'GROUNDING_DECIMAL');
  const historical={price:line.unitPriceCents,currency:line.currency,total:line.subtotalCents,stock:line.availableBaseQuantity,availability:line.available===undefined?undefined:line.available};
  const current={price:p.unit_price_cents,currency:p.currency,total:exactCents(qty,p.unit_price_cents),stock:String(stock.quantity_base),availability:decimalGte(String(stock.quantity_base),decimalString(required),'GROUNDING_DECIMAL')};
  if(current.price!==historical.price||current.currency!==historical.currency||current.stock!==historical.stock||(historical.availability!==undefined&&current.availability!==historical.availability)||current.total!==BigInt(historical.total))throw Error('GROUNDING_STALE');
  if(snap.requestedDeliveryDate!==draft.requested_delivery_date)throw Error('GROUNDING_STALE');
  const value=({product:product.stock_code,quantity:qty,uom,currency:p.currency,price:centsText(p.unit_price_cents),total:centsText(Number(current.total)),stock:String(stock.quantity_base),availability:current.availability,delivery_date:snap.requestedDeliveryDate} as Record<string,any>)[slot];
  if(value===undefined)throw Error('GROUNDING_UNSUPPORTED');return {slot,value,canonicalRef:r};
 }
 private verifyAcceptance(acceptance:any,quote:any,turn:any,conv:any){
  const db=this.database.db,message=db.prepare("SELECT id,external_message_id,sender_external_id,account_id,conversation_id,direction FROM messages WHERE id=?").get(acceptance.message_id) as any;
  if(!message||message.account_id!==turn.account_id||message.conversation_id!==turn.conversation_id||message.direction!=='INBOUND'||message.sender_external_id!==acceptance.sender_external_id)throw Error('GROUNDING_STALE');
  const evidence=parse(acceptance.evidence_json,'ACCEPTANCE_EVIDENCE');
  const currentMessage=db.prepare('SELECT text FROM messages WHERE id=?').get(message.id) as any;
  if(!evidence||evidence.accountId!==turn.account_id||evidence.conversationId!==turn.conversation_id||evidence.externalMessageId!==message.external_message_id||evidence.text!==currentMessage?.text)throw Error('GROUNDING_STALE');
  const seal=db.prepare("SELECT * FROM commercial_integrity_seals WHERE entity_type='ACCEPTANCE' AND entity_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND lineage_id=?").get(acceptance.id,turn.account_id,turn.conversation_id,conv.customer_id,quote.id) as any;
  const payload=seal&&JSON.stringify({quotationId:quote.id,messageId:acceptance.message_id,senderExternalId:acceptance.sender_external_id,acceptedAt:acceptance.accepted_at,evidenceJson:acceptance.evidence_json});
  if(!seal||seal.entity_id!==acceptance.id||seal.account_id!==turn.account_id||seal.conversation_id!==turn.conversation_id||seal.customer_id!==conv.customer_id||seal.lineage_id!==quote.id||hash(seal.payload_json)!==seal.payload_hash||payload!==seal.payload_json)throw Error('GROUNDING_STALE');
 }
 private verifyQuotation(quote:any,turn:any,conv:any){
  const db=this.database.db;if(!quote||quote.source_conversation_id!==turn.conversation_id||quote.customer_id!==conv.customer_id||typeof quote.sent_snapshot_json!=='string'||typeof quote.sent_snapshot_hash!=='string'||hash(quote.sent_snapshot_json)!==quote.sent_snapshot_hash)throw Error('GROUNDING_STALE');
  const seal=db.prepare("SELECT * FROM commercial_integrity_seals WHERE entity_type='QUOTATION' AND entity_id=? AND account_id=? AND conversation_id=? AND customer_id=?").get(quote.id,turn.account_id,turn.conversation_id,conv.customer_id) as any;if(!seal||hash(seal.payload_json)!==seal.payload_hash)throw Error('GROUNDING_STALE');
  const sealed=parse(seal.payload_json,'COMMERCIAL_SEAL');const current=quotationCommercialSealPayload(db,quote.id,quote.sent_snapshot_json);const legacy=JSON.stringify({snapshot:quote.sent_snapshot_json,lines:db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quote.id),evidence:db.prepare('SELECT qle.quotation_line_id,qle.evidence_id,qle.role FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id WHERE ql.quotation_id=? ORDER BY qle.quotation_line_id,qle.evidence_id,qle.role').all(quote.id)});if(current!==seal.payload_json&&legacy!==seal.payload_json||sealed.snapshot!==quote.sent_snapshot_json)throw Error('GROUNDING_STALE');
  const snapshot=parse(quote.sent_snapshot_json,'QUOTE_SNAPSHOT');
  if(snapshot.quotationNo!==quote.quotation_no||snapshot.customerId!==quote.customer_id||snapshot.warehouseId!==quote.warehouse_id||snapshot.currency!==quote.currency||snapshot.deliveryDate!==quote.delivery_date||snapshot.remark!==quote.remark||snapshot.subtotalCents!==quote.subtotal_cents||snapshot.taxCents!==quote.tax_cents||snapshot.grandTotalCents!==quote.grand_total_cents||!Array.isArray(snapshot.lines))throw Error('GROUNDING_STALE');
  const lines=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quote.id) as any[];
  if(lines.length!==snapshot.lines.length||!lines.length)throw Error('GROUNDING_MISSING_EVIDENCE');
  for(let i=0;i<lines.length;i++){
   const l=lines[i],s=snapshot.lines[i];
   if(s.rowItemNo!==l.row_item_no||s.productId!==l.product_id||s.stockCode!==l.stock_code||s.description!==l.stock_description||s.rowItemRemark!==l.row_item_remark||String(s.quantity)!==String(l.quantity)||s.uom!==l.uom||s.unitPriceCents!==l.unit_price_cents||s.subtotalCents!==l.subtotal_cents)throw Error('GROUNDING_STALE');
   const evidenceRows=db.prepare('SELECT qle.role,e.id AS evidence_id FROM quotation_line_evidence qle LEFT JOIN erp_evidence e ON e.id=qle.evidence_id WHERE qle.quotation_line_id=?').all(l.id) as Array<{role:string;evidence_id:string|null}>;
   if(!evidenceRows.length||evidenceRows.some(row=>!row.evidence_id))throw Error('GROUNDING_MISSING_EVIDENCE');
   if(evidenceRows.some(row=>!db.prepare('SELECT 1 FROM grounding_provenance_links WHERE evidence_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND quotation_id=?').get(row.evidence_id,turn.account_id,turn.conversation_id,conv.customer_id,quote.id)))throw Error('GROUNDING_MISSING_EVIDENCE');
   const roles=new Set(evidenceRows.map(row=>row.role));
   if(!['product','uom','price','stock'].every(role=>roles.has(role)))throw Error('GROUNDING_MISSING_EVIDENCE');
   const product=db.prepare('SELECT base_uom FROM products WHERE id=?').get(l.product_id) as {base_uom:string}|undefined;
   if(product&&String(l.uom).toUpperCase()!==String(product.base_uom).toUpperCase()&&!roles.has('uom_conversion'))throw Error('GROUNDING_MISSING_EVIDENCE');
  }
  return snapshot;
 }
 private verifySalesOrder(so:any,quote:any){
  const db=this.database.db;if(so.customer_id!==quote.customer_id||so.currency!==quote.currency||so.delivery_date!==quote.delivery_date||so.warehouse_id!==quote.warehouse_id||so.remark!==quote.remark||so.subtotal_cents!==quote.subtotal_cents||so.tax_cents!==quote.tax_cents||so.grand_total_cents!==quote.grand_total_cents)throw Error('GROUNDING_STALE');
  const ql=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quote.id) as any[];
  const sl=db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all(so.id) as any[];
  const mapped=new Set<string>();
  if(sl.length!==ql.length||sl.some(l=>{const q=ql.find(x=>x.id===l.source_quotation_line_id);if(!q||mapped.has(q.id))return true;mapped.add(q.id);return l.row_item_no!==q.row_item_no||l.product_id!==q.product_id||l.stock_code!==q.stock_code||l.stock_description!==q.stock_description||String(l.quantity)!==String(q.quantity)||l.uom!==q.uom||l.unit_price_cents!==q.unit_price_cents||l.subtotal_cents!==q.subtotal_cents})||mapped.size!==ql.length)throw Error('GROUNDING_STALE');
  const seal=db.prepare("SELECT * FROM commercial_integrity_seals WHERE entity_type='SALES_ORDER' AND entity_id=?").get(so.id) as any;const payload=seal&&JSON.stringify({quotationId:quote.id,customerId:so.customer_id,currency:so.currency,deliveryDate:so.delivery_date,warehouseId:so.warehouse_id,remark:so.remark,subtotalCents:so.subtotal_cents,taxCents:so.tax_cents,grandTotalCents:so.grand_total_cents,lines:sl});if(!seal||hash(seal.payload_json)!==seal.payload_hash||payload!==seal.payload_json)throw Error('GROUNDING_STALE');
 }
}
export const GROUNDING_PROTECTED_SLOTS=PROTECTED_FACT_SLOTS;
