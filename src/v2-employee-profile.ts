import type Database from 'better-sqlite3';
import { listCapabilities } from './v2-capability-registry.js';

export const INITIAL_SALES_PROFILE_ID = 'sales-digital-employee' as const;
export type EmployeeTurnBudgets = Readonly<{maxModelTurns:number;maxCapabilityCalls:number;perCallTimeoutMs:number;turnTimeoutMs:number;maxRepairAttempts:number}>;
export type ResolvedEmployeeProfile = Readonly<{id:string;version:number;role:string;mission:string;tone:string;languagePolicy:Readonly<{mode:'ADAPT_TO_CUSTOMER_LANGUAGE';fallbackLocale:string}>;permissions:readonly string[];forbiddenCommitments:readonly string[];escalationRules:readonly string[];turnBudgets:EmployeeTurnBudgets;active:true}>;
type EmployeeProfileRow={id:string;version:number;role:string;mission:string;tone:string;language_policy_json:string;capability_permissions_json:string;forbidden_commitments_json:string;escalation_rules_json:string;turn_budgets_json:string;active:number};

const registryPermissions=Object.freeze(listCapabilities().map(c=>c.permission.identifier));
const registryPermissionSet=new Set(registryPermissions);
const MAX_CONFIG_JSON_CHARS=16_384,MAX_POLICY_ITEMS=32;
export const PILOT_BUDGET_CEILINGS=Object.freeze({maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15_000,turnTimeoutMs:60_000,maxRepairAttempts:1});
export const INITIAL_SALES_PROFILE_SEED=Object.freeze({
 id:INITIAL_SALES_PROFILE_ID,version:1,role:'SALES_DIGITAL_EMPLOYEE',
 mission:'Assist customer sales-order goals through governed business capabilities and stop at SALES_ORDER.DRAFT.',
 tone:'CONCISE_PROFESSIONAL_STATE_AWARE',
 languagePolicy:Object.freeze({mode:'ADAPT_TO_CUSTOMER_LANGUAGE',fallbackLocale:'en-SG'}),permissions:registryPermissions,
 forbiddenCommitments:Object.freeze(['POST_SALES_ORDER','CONFIRM_SALES_ORDER','CREATE_DELIVERY_ORDER','MUTATE_ERP_TRUTH_WITHOUT_CAPABILITY','INVENT_PROTECTED_FACT','BYPASS_ACCEPTANCE_EVIDENCE','BYPASS_STAFF_AUTHORITY']),
 escalationRules:Object.freeze(['UNKNOWN_OR_AMBIGUOUS_IDENTITY','UNRESOLVED_BUSINESS_TRUTH','AUTHORITY_BOUNDARY','BUDGET_EXHAUSTED']),
 turnBudgets:Object.freeze({maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15_000,turnTimeoutMs:60_000,maxRepairAttempts:1}),active:true,
});
function fail(code:string):never{throw new Error(`EMPLOYEE_PROFILE_INVALID:${code}`)}
function nonBlank(v:unknown,code:string,max=1000){if(typeof v!=='string'||v.trim().length===0||v.length>max)fail(code);return v}
function plain(v:unknown,code:string):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail(code);return v as Record<string,unknown>}
function exactKeys(v:Record<string,unknown>,keys:readonly string[],code:string){const a=Object.keys(v).sort(),e=[...keys].sort();if(a.length!==e.length||a.some((k,i)=>k!==e[i]))fail(code)}
function parseJson(v:unknown,code:string):unknown{if(typeof v!=='string'||v.length>MAX_CONFIG_JSON_CHARS)fail(code);try{return JSON.parse(v)}catch{fail(code)}}
function stringList(v:unknown,code:string,maxItems=MAX_POLICY_ITEMS){if(!Array.isArray(v)||v.length>maxItems)fail(`${code}_SIZE`);const r=v.map(x=>nonBlank(x,code,512));if(new Set(r).size!==r.length)fail(`${code}_DUPLICATE`);return r}
function pos(v:unknown,code:string){if(!Number.isSafeInteger(v)||(v as number)<=0)fail(code);return v as number}
function nonneg(v:unknown,code:string){if(!Number.isSafeInteger(v)||(v as number)<0)fail(code);return v as number}
function deepFreeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v as Record<string,unknown>))deepFreeze(child);if(!Object.isFrozen(v))Object.freeze(v)}return v}
export function validateEmployeeProfileRow(row:unknown):ResolvedEmployeeProfile{
 const v=plain(row,'ROW');exactKeys(v,['id','version','role','mission','tone','language_policy_json','capability_permissions_json','forbidden_commitments_json','escalation_rules_json','turn_budgets_json','active'],'ROW_FIELDS');
 const id=nonBlank(v.id,'ID',120),version=pos(v.version,'VERSION'),role=nonBlank(v.role,'ROLE',120),mission=nonBlank(v.mission,'MISSION',2000),tone=nonBlank(v.tone,'TONE',240);if(v.active!==1)fail('INACTIVE');
 const lang=plain(parseJson(v.language_policy_json,'LANGUAGE_POLICY_JSON'),'LANGUAGE_POLICY');exactKeys(lang,['mode','fallbackLocale'],'LANGUAGE_POLICY_FIELDS');if(lang.mode!=='ADAPT_TO_CUSTOMER_LANGUAGE')fail('LANGUAGE_POLICY_MODE');const fallbackLocale=nonBlank(lang.fallbackLocale,'LANGUAGE_POLICY_LOCALE',40);
 const permissions=stringList(parseJson(v.capability_permissions_json,'PERMISSIONS_JSON'),'PERMISSIONS',registryPermissions.length);if(permissions.some(p=>!registryPermissionSet.has(p)))fail('PERMISSION_NOT_REGISTERED');
 const forbiddenCommitments=stringList(parseJson(v.forbidden_commitments_json,'FORBIDDEN_COMMITMENTS_JSON'),'FORBIDDEN_COMMITMENTS');const escalationRules=stringList(parseJson(v.escalation_rules_json,'ESCALATION_RULES_JSON'),'ESCALATION_RULES');
 const b=plain(parseJson(v.turn_budgets_json,'TURN_BUDGETS_JSON'),'TURN_BUDGETS');exactKeys(b,['maxModelTurns','maxCapabilityCalls','perCallTimeoutMs','turnTimeoutMs','maxRepairAttempts'],'TURN_BUDGETS_FIELDS');const turnBudgets={maxModelTurns:pos(b.maxModelTurns,'MAX_MODEL_TURNS'),maxCapabilityCalls:pos(b.maxCapabilityCalls,'MAX_CAPABILITY_CALLS'),perCallTimeoutMs:pos(b.perCallTimeoutMs,'PER_CALL_TIMEOUT'),turnTimeoutMs:pos(b.turnTimeoutMs,'TURN_TIMEOUT'),maxRepairAttempts:nonneg(b.maxRepairAttempts,'MAX_REPAIR_ATTEMPTS')};if(turnBudgets.perCallTimeoutMs>turnBudgets.turnTimeoutMs)fail('CALL_TIMEOUT_EXCEEDS_TURN');for(const key of Object.keys(PILOT_BUDGET_CEILINGS) as Array<keyof EmployeeTurnBudgets>)if(turnBudgets[key]>PILOT_BUDGET_CEILINGS[key])fail('TURN_BUDGET_EXCEEDS_PILOT_CAP');
 return deepFreeze({id,version,role,mission,tone,languagePolicy:{mode:'ADAPT_TO_CUSTOMER_LANGUAGE' as const,fallbackLocale},permissions:[...permissions],forbiddenCommitments:[...forbiddenCommitments],escalationRules:[...escalationRules],turnBudgets,active:true as const});
}
export class EmployeeProfileResolver{constructor(private readonly db:Database.Database){}resolve(profileId:string=INITIAL_SALES_PROFILE_ID){const id=nonBlank(profileId,'ID',120);const row=this.db.prepare('SELECT id,version,role,mission,tone,language_policy_json,capability_permissions_json,forbidden_commitments_json,escalation_rules_json,turn_budgets_json,active FROM employee_profiles WHERE id=?').get(id) as EmployeeProfileRow|undefined;if(!row)throw new Error('EMPLOYEE_PROFILE_NOT_FOUND');return validateEmployeeProfileRow(row)}}
export function profileAuthorization(profile:ResolvedEmployeeProfile){return deepFreeze({profileId:profile.id,permissions:[...profile.permissions] as readonly string[]})}
