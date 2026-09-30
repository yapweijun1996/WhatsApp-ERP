import { parentPort, workerData } from 'node:worker_threads';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';

class RaceChannel {
  async connect() {}
  async disconnect() {}
  async getStatus() { return 'connected' as const; }
  onMessage() {}
  async send(message: any) {
    parentPort!.postMessage({ sent: true, clientMessageId: message.clientMessageId });
    return { status: 'submitted' as const, externalMessageId: `race-${workerData.owner}` };
  }
  async reconcile() { return { status: 'submitted' as const, externalMessageId: 'unused' }; }
}

let database: V1Database | undefined;
try {
  database = new V1Database(workerData.file);
  const service = new CommerceService(database, new RaceChannel() as any);
  const barrier = new Int32Array(workerData.barrier);
  parentPort!.postMessage({ constructed: true });
  if (workerData.constructionOnly) {
    const trigger = database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='agent_turns_identity_immutable'").get();
    if (!trigger) throw Error('identity trigger missing after construction');
    parentPort!.postMessage({ done: true });
  } else {
    while (Atomics.load(barrier, 0) === 0) Atomics.wait(barrier, 0, 0, 1000);
    const initial = database.db.prepare('SELECT id,status FROM outbound_messages WHERE entity_id=? ORDER BY rowid DESC LIMIT 1').get(workerData.quotationId);
    if ((initial as any)?.status !== (workerData.initialStatus ?? undefined)) throw Error(`unexpected initial outbound: ${JSON.stringify(initial)}`);
    parentPort!.postMessage({ ready: true });
    while (Atomics.load(barrier, 0) === 0) Atomics.wait(barrier, 0, 0, 1000);
    await (service as any).sendQuoteUnlocked(workerData.quotationId);
    parentPort!.postMessage({ done: true });
  }
} catch (error) {
  parentPort!.postMessage({ error: String(error) });
} finally {
  database?.db.close();
}
