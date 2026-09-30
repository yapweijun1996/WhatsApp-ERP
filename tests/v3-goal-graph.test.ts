import assert from 'node:assert/strict';
import {test} from 'node:test';
import {V1Database} from '../src/database.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {canonicalJson,canonicalSha256} from '../src/v2-canonical.js';

const scope = {accountId: 'demo-account', conversationId: 'conv-001'};
const goal = (id: string, status: 'OPEN'|'IN_PROGRESS'|'FULFILLED'|'SUPERSEDED'|'CANCELLED' = 'OPEN') => buildConversationGoal({goalId:id, ...scope, sourceMessageIds:[`message-${id}`], sourceAttachmentIds:[], erpObjectRefs:[], parentGoalId:null, dependsOnGoalIds:[], relatedGoalIds:[], description:`obligation ${id}`, status, createdBy:'AGENT', createdAt:'2026-09-14T00:00:00.000Z', updatedAt:'2026-09-14T00:00:01.000Z', fulfillmentEvidenceRefs:[]});
function fixture() { const database = new V1Database(':memory:'); database.resetAndSeed(); return {database, store:new V3GoalGraphStore(database)}; }

test('persists an immutable event and deterministically rebuilds it', () => {
  const {database,store} = fixture();
  store.appendGoalEvent({scope,eventId:'event-1',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'idem-1',createdAt:'2026-09-14T00:00:02.000Z'});
  const first = store.readGoalGraph(scope), second = store.rebuildGoalGraph(scope);
  assert.deepEqual(first, second); assert.equal(first.goals[0].goalId, 'g1');
  assert.throws(() => database.db.prepare("UPDATE conversation_goal_events SET goal_id='tampered'").run(), /IMMUTABLE_V3_GOAL_EVENT/);
  database.db.close();
});

test('public graph writer requires CREATED goals to be OPEN', () => {
  const {database,store} = fixture();
  assert.throws(() => store.appendGoalEvent({scope,eventId:'created',goal:goal('g1','FULFILLED'),eventType:'CREATED',idempotencyKey:'created-key',createdAt:'2026-09-14T00:00:02.000Z'}), /V3_GOAL_EVENT_ILLEGAL_TRANSITION/);
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM conversation_goal_events').get().n, 0);
  database.db.close();
});

test('duplicate writes are idempotent, conflicts fail closed, and edges are descriptive', () => {
  const {database,store} = fixture();
  const input = {scope,eventId:'event-1',goal:buildConversationGoal({...goal('g1'),relatedGoalIds:['g2']}),eventType:'CREATED' as const,idempotencyKey:'idem-1',createdAt:'2026-09-14T00:00:02.000Z'};
  store.appendGoalEvent(input); store.appendGoalEvent(input);
  assert.throws(() => store.appendGoalEvent({...input,eventId:'event-2',goal:goal('different')}), /IDEMPOTENCY_CONFLICT/);
  store.appendGoalEvent({scope,eventId:'event-2',goal:buildConversationGoal({...goal('g2'),relatedGoalIds:['g2-peer']}),eventType:'CREATED',idempotencyKey:'idem-2',createdAt:'2026-09-14T00:00:03.000Z'});
  store.appendGoalEvent({scope,eventId:'event-3',goal:buildConversationGoal({...goal('g2-peer'),relatedGoalIds:['g2']}),eventType:'CREATED',idempotencyKey:'idem-3',createdAt:'2026-09-14T00:00:03.000Z'});
  store.appendGoalEdge({scope,edgeId:'edge-1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'edge-idem',createdAt:'2026-09-14T00:00:04.000Z'});
  assert.equal(store.appendGoalEdge({scope,edgeId:'edge-1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'edge-idem',createdAt:'2026-09-14T00:00:04.000Z'}).edge_id, 'edge-1');
  assert.throws(() => store.appendGoalEdge({scope,edgeId:'edge-2',fromGoalId:'g1',toGoalId:'g1',edgeType:'RELATED',idempotencyKey:'edge-2',createdAt:'2026-09-14T00:00:05.000Z'}), /SELF/);
  database.db.close();
});

test('rejects cross-scope and unknown graph references', () => {
  const {database,store} = fixture();
  assert.throws(() => store.appendGoalEvent({scope:{accountId:'other',conversationId:'conv-001'},eventId:'x',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'x',createdAt:'2026-09-14T00:00:02.000Z'}), /SCOPE/);
  assert.throws(() => store.appendGoalEdge({scope,edgeId:'x',fromGoalId:'missing',toGoalId:'also-missing',edgeType:'DEPENDENCY',idempotencyKey:'x',createdAt:'2026-09-14T00:00:02.000Z'}), /GOAL_NOT_FOUND/);
  assert.throws(() => database.db.prepare("INSERT INTO conversation_goal_edges VALUES('x','other','conv-001','a','b','RELATED','ADDED','x','2026-09-14T00:00:02Z',99)").run(), /V3_GOAL_EDGE_(INSERT_REQUIRES_SERVICE|SCOPE)/);
  database.db.close();
});

test('raw SQL cannot forge canonical goal history, while the host fence permits exact writes only', () => {
  const {database,store} = fixture();
  const g = goal('g1'), json = canonicalJson(g), hash = canonicalSha256(g);
  assert.throws(() => database.db.prepare('INSERT INTO conversation_goal_events(event_id,account_id,conversation_id,goal_id,event_type,goal_json,goal_hash,idempotency_key,created_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?)').run('raw','demo-account','conv-001','g1','CREATED',json,hash,'raw-key','2026-09-14T00:00:02.000Z',1), /V3_GOAL_EVENT_INSERT_REQUIRES_SERVICE/);
  store.appendGoalEvent({scope,eventId:'host',goal:g,eventType:'CREATED',idempotencyKey:'host-key',createdAt:'2026-09-14T00:00:02.000Z'});
  assert.equal(database.db.prepare('SELECT revision FROM conversation_goal_events WHERE event_id=?').get('host').revision, 1);
  database.db.close();
});

test('V3Database insert bypasses are absent and raw SQL remains fail-closed', () => {
  const {database,store} = fixture();
  assert.equal((database as any).insertV3GoalEvent, undefined);
  assert.equal((database as any).insertV3GoalEdge, undefined);
  const g = goal('g1'), json = canonicalJson(g), hash = canonicalSha256(g);
  assert.throws(() => database.db.prepare('INSERT INTO conversation_goal_events(event_id,account_id,conversation_id,goal_id,event_type,goal_json,goal_hash,idempotency_key,created_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?)').run('raw','demo-account','conv-001','g1','CREATED',json,hash,'raw-key','2026-09-14T00:00:02.000Z',999), /V3_GOAL_EVENT/);
  store.appendGoalEvent({scope,eventId:'host',goal:g,eventType:'CREATED',idempotencyKey:'host-key',createdAt:'2026-09-14T00:00:02.000Z'});
  database.db.close();
});

test('multiple stores share one connection mutation fence while raw SQL stays blocked', () => {
  const {database} = fixture();
  const store1 = new V3GoalGraphStore(database), store2 = new V3GoalGraphStore(database);
  store1.appendGoalEvent({scope,eventId:'g1',goal:buildConversationGoal({...goal('g1'),relatedGoalIds:['g2']}),eventType:'CREATED',idempotencyKey:'g1-key',createdAt:'2026-09-14T00:00:01.000Z'});
  store2.appendGoalEvent({scope,eventId:'g2',goal:buildConversationGoal({...goal('g2'),relatedGoalIds:['g1']}),eventType:'CREATED',idempotencyKey:'g2-key',createdAt:'2026-09-14T00:00:02.000Z'});
  store1.appendGoalEdge({scope,edgeId:'e1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'e1-key',createdAt:'2026-09-14T00:00:03.000Z'});
  store2.appendGoalEdge({scope,edgeId:'e1-remove',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',edgeEventType:'REMOVED',idempotencyKey:'e1-remove-key',createdAt:'2026-09-14T00:00:04.000Z'});
  assert.throws(() => database.db.prepare("INSERT INTO conversation_goal_events(event_id,account_id,conversation_id,goal_id,event_type,goal_json,goal_hash,idempotency_key,created_at,revision) VALUES('raw','demo-account','conv-001','g1','CREATED','{}','raw-hash','raw-key','2026-09-14T00:00:05.000Z',5)").run(), /V3_GOAL_EVENT_INSERT_REQUIRES_SERVICE/);
  assert.equal((database as any).insertV3GoalEvent, undefined);
  assert.equal((database as any).insertV3GoalEdge, undefined);
  assert.deepEqual(database.db.prepare('SELECT revision,event_id FROM conversation_goal_events ORDER BY revision').all(), [{revision:1,event_id:'g1'},{revision:2,event_id:'g2'}]);
  assert.deepEqual(database.db.prepare('SELECT revision,edge_id,edge_event_type FROM conversation_goal_edges ORDER BY revision').all(), [{revision:3,edge_id:'e1',edge_event_type:'ADDED'},{revision:4,edge_id:'e1-remove',edge_event_type:'REMOVED'}]);
  database.db.close();
});

test('edge events support add-remove-re-add and rebuild active state by conversation revision', () => {
  const {database,store} = fixture();
  store.appendGoalEvent({scope,eventId:'g1',goal:buildConversationGoal({...goal('g1'),relatedGoalIds:['g2']}),eventType:'CREATED',idempotencyKey:'g1-key',createdAt:'2026-09-14T00:00:01.000Z'});
  store.appendGoalEvent({scope,eventId:'g2',goal:buildConversationGoal({...goal('g2'),relatedGoalIds:['g1']}),eventType:'CREATED',idempotencyKey:'g2-key',createdAt:'2026-09-14T00:00:02.000Z'});
  const add={scope,edgeId:'e1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED' as const,idempotencyKey:'add-1',createdAt:'2026-09-14T00:00:03.000Z'};
  store.appendGoalEdge(add);
  store.appendGoalEvent({scope,eventId:'g1-update',goal:buildConversationGoal({...goal('g1','IN_PROGRESS'),relatedGoalIds:['g2']}),eventType:'UPDATED',idempotencyKey:'g1-update-key',createdAt:'2026-09-14T00:00:04.000Z'});
  store.appendGoalEdge({...add,edgeId:'e1-remove',edgeEventType:'REMOVED',idempotencyKey:'remove-1',createdAt:'2026-09-14T00:00:05.000Z'});
  assert.throws(() => store.appendGoalEdge({...add,edgeId:'e1-remove-2',edgeEventType:'REMOVED',idempotencyKey:'remove-2',createdAt:'2026-09-14T00:00:06.000Z'}), /REMOVE_STALE/);
  store.appendGoalEdge({...add,edgeId:'e2',idempotencyKey:'add-2',createdAt:'2026-09-14T00:00:07.000Z'});
  assert.deepEqual(store.rebuildGoalGraph(scope).edges.map(e=>e.edgeId), ['e2']);
  assert.deepEqual(database.db.prepare('SELECT edge_event_type,revision FROM conversation_goal_edges ORDER BY revision').all(), [{edge_event_type:'ADDED',revision:3},{edge_event_type:'REMOVED',revision:5},{edge_event_type:'ADDED',revision:6}]);
  database.db.close();
});

test('revision is authoritative and backdated wall-clock mutations are rejected', () => {
  const {database,store} = fixture();
  store.appendGoalEvent({scope,eventId:'created',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'created-key',createdAt:'2026-09-14T00:00:10.000Z'});
  assert.throws(() => store.appendGoalEvent({scope,eventId:'updated',goal:goal('g1','IN_PROGRESS'),eventType:'UPDATED',idempotencyKey:'updated-key',createdAt:'2026-09-14T00:00:09.000Z'}), /BACKDATED_TIME/);
  store.appendGoalEvent({scope,eventId:'updated',goal:goal('g1','IN_PROGRESS'),eventType:'UPDATED',idempotencyKey:'updated-key',createdAt:'2026-09-14T00:00:10.000Z'});
  assert.deepEqual(database.db.prepare('SELECT revision,event_id FROM conversation_goal_events ORDER BY revision').all(), [{revision:1,event_id:'created'},{revision:2,event_id:'updated'}]);
  assert.equal(store.readGoalGraph(scope).goals[0].status, 'IN_PROGRESS'); database.db.close();
});

test('public graph writer rejects UPDATED after terminal goals while preserving active updates and exact replay', () => {
  for (const terminal of ['SUPERSEDED', 'CANCELLED'] as const) {
    const {database,store} = fixture();
    const created = {scope,eventId:'created',goal:goal('g1'),eventType:'CREATED' as const,idempotencyKey:'created-key',createdAt:'2026-09-14T00:00:02.000Z'};
    store.appendGoalEvent(created);
    const terminalEvent = {scope,eventId:'terminal',goal:goal('g1',terminal),eventType:(terminal === 'SUPERSEDED' ? 'SUPERSEDED' : 'CANCELLED') as 'SUPERSEDED'|'CANCELLED',idempotencyKey:'terminal-key',createdAt:'2026-09-14T00:00:03.000Z'};
    const committed = store.appendGoalEvent(terminalEvent);
    assert.deepEqual(store.appendGoalEvent(terminalEvent), committed);
    assert.throws(() => store.appendGoalEvent({scope,eventId:'update',goal:goal('g1','IN_PROGRESS'),eventType:'UPDATED',idempotencyKey:'update-key',createdAt:'2026-09-14T00:00:04.000Z'}), /V3_GOAL_EVENT_ILLEGAL_TRANSITION/);
    assert.equal(database.db.prepare('SELECT count(*) AS n FROM conversation_goal_events').get().n, 2);
    database.db.close();
  }
  const {database,store} = fixture();
  store.appendGoalEvent({scope,eventId:'created',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'created-key',createdAt:'2026-09-14T00:00:02.000Z'});
  assert.equal(store.appendGoalEvent({scope,eventId:'update',goal:goal('g1','IN_PROGRESS'),eventType:'UPDATED',idempotencyKey:'update-key',createdAt:'2026-09-14T00:00:03.000Z'}).event_type, 'UPDATED');
  database.db.close();
});

test('goal graph mutation inputs are closed and accessor-safe', () => {
  const {database,store} = fixture(); let calls = 0;
  const input:any = {scope,eventId:'x',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'x',createdAt:'2026-09-14T00:00:02.000Z'};
  Object.defineProperty(input,'eventId',{enumerable:true,get(){calls++; throw new Error('getter')}});
  assert.throws(() => store.appendGoalEvent(input), /INPUT_SHAPE/); assert.equal(calls,0);
  const nested:any = {scope:{accountId:'demo-account',conversationId:'conv-001'},eventId:'x',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'x',createdAt:'2026-09-14T00:00:02.000Z'}; Object.defineProperty(nested.scope,'accountId',{enumerable:true,get(){calls++; throw new Error('getter')}});
  assert.throws(() => store.appendGoalEvent(nested), /INPUT_SHAPE/); assert.equal(calls,0);
  const extra:any = {scope,eventId:'x',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'x',createdAt:'2026-09-14T00:00:02.000Z',extra:true}; assert.throws(() => store.appendGoalEvent(extra), /INPUT_SHAPE/); database.db.close();
});

test('event and edge identities are independently resolved and chimera requests fail closed', () => {
  const {database,store} = fixture();
  const created={scope,eventId:'created',goal:goal('g1'),eventType:'CREATED' as const,idempotencyKey:'created-key',createdAt:'2026-09-14T00:00:01.000Z'}; store.appendGoalEvent(created);
  const update={scope,eventId:'u1',goal:buildConversationGoal({...goal('g1','IN_PROGRESS'),relatedGoalIds:['g2']}),eventType:'UPDATED' as const,idempotencyKey:'k1',createdAt:'2026-09-14T00:00:02.000Z'}; store.appendGoalEvent(update);
  store.appendGoalEvent({...update,eventId:'u2',idempotencyKey:'k2'});
  assert.throws(() => store.appendGoalEvent({...update,eventId:'u1',idempotencyKey:'k2'}), /IDEMPOTENCY_CONFLICT/);
  store.appendGoalEvent({scope,eventId:'g2',goal:buildConversationGoal({...goal('g2'),relatedGoalIds:['g1']}),eventType:'CREATED',idempotencyKey:'g2-key',createdAt:'2026-09-14T00:00:03.000Z'});
  store.appendGoalEdge({scope,edgeId:'e1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'e-key',createdAt:'2026-09-14T00:00:04.000Z'});
  assert.throws(() => store.appendGoalEdge({scope,edgeId:'e1',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'other-key',createdAt:'2026-09-14T00:00:04.000Z'}), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => store.appendGoalEdge({scope,edgeId:'other-edge',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'e-key',createdAt:'2026-09-14T00:00:04.000Z'}), /IDEMPOTENCY_CONFLICT/); database.db.close();
});

test('persisted edge direction must match the GOAL-001 relationship snapshot', () => {
  const {database,store} = fixture();
  store.appendGoalEvent({scope,eventId:'g1',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'g1-key',createdAt:'2026-09-14T00:00:01.000Z'});
  store.appendGoalEvent({scope,eventId:'g2',goal:buildConversationGoal({...goal('g2'),relatedGoalIds:['g1']}),eventType:'CREATED',idempotencyKey:'g2-key',createdAt:'2026-09-14T00:00:02.000Z'});
  assert.throws(() => store.appendGoalEdge({scope,edgeId:'e',fromGoalId:'g1',toGoalId:'g2',edgeType:'RELATED',idempotencyKey:'e-key',createdAt:'2026-09-14T00:00:03.000Z'}), /EDGE_SNAPSHOT_CONFLICT/);
  database.db.close();
});

test('new structures coexist with canonical V1/V2 data and reset does not retain derived state', () => {
  const {database,store} = fixture();
  const before = database.db.prepare('SELECT id,customer_id,status FROM conversations').all();
  store.appendGoalEvent({scope,eventId:'event-1',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'idem-1',createdAt:'2026-09-14T00:00:02.000Z'});
  database.resetAndSeed();
  assert.deepEqual(database.db.prepare('SELECT id,customer_id,status FROM conversations').all(), before);
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM conversation_goal_events').get().n, 0);
  database.db.close();
});

test('restart preserves the append-only shadow history', () => {
  const {database,store} = fixture(); const dir = '/tmp/v3-goal-graph-restart.sqlite';
  database.db.close();
  const first = new V1Database(dir); first.resetAndSeed(); const firstStore = new V3GoalGraphStore(first);
  firstStore.appendGoalEvent({scope,eventId:'event-1',goal:goal('g1'),eventType:'CREATED',idempotencyKey:'idem-1',createdAt:'2026-09-14T00:00:02.000Z'}); first.db.close();
  const resumed = new V1Database(dir); assert.equal(new V3GoalGraphStore(resumed).readGoalGraph(scope).goals[0].goalId,'g1'); resumed.db.close();
});
