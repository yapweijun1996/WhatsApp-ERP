import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

/** Exact, host-created reference descriptors permitted in a final decision. */
export type GroundingReferenceProjection = Readonly<{
  descriptors: readonly string[];
  references: readonly Readonly<{descriptor:string;sourceId:string;versionOrRevision:string;evidenceRefs:readonly string[];allowedClaims?:readonly Readonly<{slot:string;valueShape:string}>[]}>[];
}>;

const stableValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stableValue)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stableValue((value as Record<string, unknown>)[key])]))
    : value;
const stableJson = (value: unknown) => JSON.stringify(stableValue(value));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * `expectedTurnId` is supplied by runtime/grounding callers. The candidate
 * object is merely an untrusted transport projection; every security-relevant
 * field is checked against the durable action/result rows before use.
 */
export function buildGroundingReferenceProjection(db: Database.Database, accountId: string, conversationId: string, actionResults: readonly unknown[] = [], expectedTurnId?: string): GroundingReferenceProjection {
  const references: Array<{descriptor:string;sourceId:string;versionOrRevision:string;evidenceRefs:string[];allowedClaims?:readonly Readonly<{slot:string;valueShape:string}>[]}> = [];
  const add = (descriptor:string, sourceId:string, versionOrRevision:string, ids: string[], lineageSql='', lineageArgs: unknown[] = []) => {
    const evidenceRefs = [...new Set(ids)].filter(id => typeof id === 'string' && Boolean(db.prepare(`SELECT 1 FROM erp_evidence e WHERE e.id=? AND EXISTS (SELECT 1 FROM grounding_provenance_links p WHERE p.evidence_id=e.id AND p.account_id=? AND p.conversation_id=? AND p.customer_id=? ${lineageSql})`).get(id,accountId,conversationId,conv?.customer_id,...lineageArgs)));
    if (evidenceRefs.length) references.push({descriptor,sourceId,versionOrRevision,evidenceRefs});
  };
  const conv = db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId, accountId) as {customer_id:string}|undefined;
  if (!conv?.customer_id) return {descriptors:[],references:[]};
  for (const candidate of actionResults) {
    try {
      const action:any=candidate, args=action?.arguments, result=action?.result;
      if(!action?.id || !action?.turnId || (expectedTurnId !== undefined && action.turnId !== expectedTurnId)) continue;
      const durableAction=db.prepare('SELECT id,turn_id,sequence,capability_name,capability_version,arguments_json,arguments_hash FROM agent_actions WHERE id=?').get(action.id) as any;
      const durableResult=db.prepare('SELECT action_id,turn_id,sequence,result_json,result_hash FROM agent_action_results WHERE action_id=?').get(action.id) as any;
      if(!durableAction||!durableResult||durableAction.turn_id!==action.turnId||durableAction.sequence!==action.sequence||durableResult.turn_id!==action.turnId||durableResult.sequence!==action.sequence||sha256(durableAction.arguments_json)!==durableAction.arguments_hash||sha256(durableResult.result_json)!==durableResult.result_hash) continue;
      if(stableJson(args)!==durableAction.arguments_json||stableJson(result)!==durableResult.result_json) continue;
      if(!db.prepare('SELECT 1 FROM agent_turns WHERE id=? AND account_id=? AND conversation_id=?').get(action.turnId,accountId,conversationId)) continue;
      if(action.capability?.name!=='read_order_draft'||action.capability?.version!=='v1'||!args||args.accountId!==accountId||args.conversationId!==conversationId||args.customerId!==conv.customer_id||result?.status!=='SUCCEEDED') continue;
      const data=result.data,draft=db.prepare("SELECT id,current_revision FROM order_drafts WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=? AND status='CURRENT'").get(args.draftId,accountId,conversationId,conv.customer_id) as any;
      if(!draft||data?.draftId!==draft.id||Number(data?.revision??data?.draftRevision)!==draft.current_revision||Number(args.revision)!==draft.current_revision||!Array.isArray(data?.lines)||data.lines.length===0) continue;
      const durable=db.prepare('SELECT line_no,requested_wording,quantity,requested_uom FROM order_draft_lines WHERE draft_id=? ORDER BY line_no').all(draft.id) as any[];
      if(durable.length!==data.lines.length||data.lines.some((line:any,i:number)=>!line||line.lineNo!==durable[i].line_no||line.requestedWording!==durable[i].requested_wording||String(line.quantity)!==String(durable[i].quantity)||line.requestedUom!==durable[i].requested_uom)) continue;
      const sourceId=`draft:${draft.id}`,versionOrRevision=`revision:${draft.current_revision}`,descriptor=`${sourceId}:${versionOrRevision}`;
      references.push({descriptor,sourceId,versionOrRevision,evidenceRefs:[descriptor],allowedClaims:[{slot:'current_order_draft_items',valueShape:'order_draft_items'}]});
    } catch { /* untrusted action/result: fail closed */ }
  }
  const validationIds = new Set<string>();
  const rows = db.prepare("SELECT v.evidence_refs_json,v.result_json,d.id draft_id,d.current_revision FROM v2_order_validations v JOIN order_drafts d ON d.id=v.draft_id WHERE d.account_id=? AND d.conversation_id=? AND d.customer_id=? AND d.status='CURRENT' AND v.draft_revision=d.current_revision AND v.mode='DRAFT' AND v.status='SUCCEEDED'").all(accountId,conversationId,conv.customer_id) as Array<{evidence_refs_json:string;result_json:string;draft_id:string;current_revision:number}>;
  for (const row of rows) { try { const result=JSON.parse(row.result_json),raw=JSON.parse(row.evidence_refs_json),data=result?.data??result; if (!result||data?.draftId!==row.draft_id||data?.draftRevision!==row.current_revision||!Array.isArray(raw)||raw.length===0) continue; const ids:string[]=[]; for (const item of raw) { const id=typeof item==='string'?item:item?.sourceId; const refs=typeof item==='string'?[item]:item?.evidenceRefs; if(typeof id!=='string'||!Array.isArray(refs)||refs.length===0||refs.some((ref:any)=>typeof ref!=='string'||!db.prepare('SELECT 1 FROM erp_evidence WHERE id=?').get(ref))||!db.prepare('SELECT 1 FROM erp_evidence WHERE id=?').get(id)) { ids.length=0; break; } ids.push(id,...refs); } if (ids.length===0) continue; for (const id of new Set(ids)) validationIds.add(id); } catch { /* fail closed */ } }
  const validationEvidence=[...validationIds];
  const eligibility=validationEvidence.filter(id=>(db.prepare('SELECT evidence_type FROM erp_evidence WHERE id=?').get(id) as {evidence_type:string}|undefined)?.evidence_type==='customer_eligibility');
  const customer=db.prepare('SELECT id FROM customers WHERE id=?').get(conv.customer_id) as {id:string}|undefined;
  if (customer) add(`customer:${customer.id}`,customer.id,`customer:${customer.id}`,eligibility,' AND p.draft_id=? AND p.draft_revision=?',[...((rows[0] as any)?.draft_id ? [ (rows[0] as any).draft_id, (rows[0] as any).current_revision ] : [])]);
  for (const id of validationEvidence) { const row=db.prepare('SELECT source_version FROM erp_evidence WHERE id=?').get(id) as {source_version:string}|undefined; const lineage=rows.find(x=>{try{return JSON.parse(x.evidence_refs_json).some((r:any)=>(typeof r==='string'?r:r?.sourceId)===id)}catch{return false}}); if (row&&lineage) add(`evidence:${id}:${row.source_version}`,id,row.source_version,[id],' AND p.draft_id=? AND p.draft_revision=?',[lineage.draft_id,lineage.current_revision]); }
  const quoteEvidence=(quotationId:string) => db.prepare('SELECT DISTINCT e.id,e.source_version FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id AND ql.quotation_id=? JOIN erp_evidence e ON e.id=qle.evidence_id').all(quotationId) as Array<{id:string;source_version:string}>;
  const quotes=db.prepare('SELECT id,status FROM quotations WHERE source_conversation_id=? AND customer_id=?').all(conversationId,conv.customer_id) as Array<{id:string;status:string}>;
  for (const quote of quotes) { const ev=quoteEvidence(quote.id); add(`quote:${quote.id}:${quote.status}`,quote.id,`quote:${quote.id}:${quote.status}`,ev.map(x=>x.id),' AND p.quotation_id=?',[quote.id]); for (const row of ev) add(`evidence:${row.id}:${row.source_version}`,row.id,row.source_version,[row.id],' AND p.quotation_id=?',[quote.id]); }
  const orders=db.prepare('SELECT s.id,s.status,s.source_quotation_id FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE q.source_conversation_id=? AND q.customer_id=?').all(conversationId,conv.customer_id) as Array<{id:string;status:string;source_quotation_id:string}>;
  for (const order of orders) add(`so:${order.id}:${order.status}`,order.id,`so:${order.id}:${order.status}`,quoteEvidence(order.source_quotation_id).map(x=>x.id),' AND p.quotation_id=? AND (p.sales_order_id IS NULL OR p.sales_order_id=?)',[order.source_quotation_id,order.id]);
  const accepts=db.prepare('SELECT a.id,a.quotation_id,q.status FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE q.source_conversation_id=? AND q.customer_id=?').all(conversationId,conv.customer_id) as Array<{id:string;quotation_id:string;status:string}>;
  for (const acceptance of accepts) add(`acceptance:${acceptance.id}:${acceptance.status}`,acceptance.id,`acceptance:${acceptance.id}:${acceptance.status}`,quoteEvidence(acceptance.quotation_id).map(x=>x.id),' AND p.quotation_id=? AND (p.acceptance_id IS NULL OR p.acceptance_id=?)',[acceptance.quotation_id,acceptance.id]);
  return {descriptors:[...new Set(references.map(x=>x.descriptor))],references};
}
