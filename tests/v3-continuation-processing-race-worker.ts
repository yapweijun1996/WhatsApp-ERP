import {parentPort, workerData} from 'node:worker_threads';
import {V1Database} from '../src/database.js';
import {V3ContinuationProcessor} from '../src/v3-continuation-processing.js';

const data = workerData as {file: string; barrier: SharedArrayBuffer; input: any; mode?: 'process'|'reserve'};
const view = new Int32Array(data.barrier);
parentPort!.postMessage({ready: true});
while (Atomics.load(view, 0) === 0) Atomics.wait(view, 0, 0, 1000);
let database: V1Database | undefined;
try { database = new V1Database(data.file); const result = data.mode === 'reserve' ? database.v3WakeReserve(data.input) : new V3ContinuationProcessor(database).process(data.input); parentPort!.postMessage(data.mode === 'reserve' && result.status === 'BUDGET_EXHAUSTED' ? {ok: false, error: 'BUDGET_EXHAUSTED', result} : {ok: true, result}); }
catch (error) { parentPort!.postMessage({ok: false, error: String(error)}); }
finally { database?.db.close(); }
