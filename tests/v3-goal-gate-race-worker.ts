import {parentPort, workerData} from 'node:worker_threads';
import {V1Database} from '../src/database.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';

const database = new V1Database(workerData.file);
try {
  parentPort!.postMessage({ready: true});
  Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
  new V3GoalGraphStore(database).appendGoalEvent(workerData.event);
  parentPort!.postMessage({ok: true});
} catch (error) {
  parentPort!.postMessage({ok: false, error: String(error)});
} finally {
  database.db.close();
}
