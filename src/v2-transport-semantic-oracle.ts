import { canonicalJson, canonicalSha256 } from './v2-canonical.js';
import { normalizeTurnTrace, type TurnTrace } from './v2-agent-model-transport.js';

export type TransportBusinessProjection = Readonly<{
  turnId: string;
  decision: unknown;
  registryInvocation?: unknown;
  capabilityResult?: unknown;
  capabilityError?: unknown;
  evidence: unknown;
  stateChanges: unknown;
  outboundDisposition: unknown;
  grounding: unknown;
  terminal: unknown;
}>;
export type SemanticParityResult = Readonly<{ equal: boolean; leftHash: string; rightHash: string; mismatchCode?: string; mismatchPath?: string }>;

function mismatchPath(left: any, right: any, path = '$'): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null) return path;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return path;
    for (let i = 0; i < left.length; i++) { const found = mismatchPath(left[i], right[i], `${path}[${i}]`); if (found) return found; }
    return undefined;
  }
  if (typeof left === 'object') {
    const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const name of names) { const found = mismatchPath(left[name], right[name], `${path}.${name}`); if (found) return found; }
    return undefined;
  }
  return path;
}

export function normalizeTransportBusinessProjection(trace: TurnTrace): TransportBusinessProjection {
  const value = normalizeTurnTrace(trace);
  // Deliberately omit only transport metadata and connective wording. Every
  // host-semantic field below remains part of parity.
  return Object.freeze({ turnId: value.turnId, decision: value.decision, registryInvocation: value.registryInvocation, capabilityResult: value.capabilityResult, capabilityError: value.capabilityError, evidence: value.evidence, stateChanges: value.stateChanges, outboundDisposition: value.outboundDisposition, grounding: value.grounding, terminal: value.terminal });
}

export function compareTransportSemanticParity(left: TurnTrace, right: TurnTrace): SemanticParityResult {
  let a: TransportBusinessProjection, b: TransportBusinessProjection;
  try { a = normalizeTransportBusinessProjection(left); b = normalizeTransportBusinessProjection(right); } catch { return { equal: false, leftHash: '', rightHash: '', mismatchCode: 'SEMANTIC_PARITY_INVALID_TRACE', mismatchPath: '$' }; }
  const leftHash = canonicalSha256(a), rightHash = canonicalSha256(b);
  if (leftHash === rightHash) return { equal: true, leftHash, rightHash };
  return { equal: false, leftHash, rightHash, mismatchCode: 'SEMANTIC_PARITY_MISMATCH', mismatchPath: mismatchPath(JSON.parse(canonicalJson(a)), JSON.parse(canonicalJson(b)))?.slice(0, 256) ?? '$' };
}

export function assertTransportSemanticParity(left: TurnTrace, right: TurnTrace): void {
  const result = compareTransportSemanticParity(left, right);
  if (!result.equal) throw new Error(`${result.mismatchCode}:${result.mismatchPath}`);
}
