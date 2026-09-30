import type { OrderIntentResult, InterpretedOrderLine } from '../src/pi-agent.js';
import type { OrderSemanticAgentFactory } from '../src/commerce.js';

export const GOLDEN_LINES: InterpretedOrderLine[] = [
  { query: 'Ayam', quantity: 10, uom: 'CTN' },
  { query: 'red one', quantity: 5, uom: 'CTN' },
];
export const goldenOffer = (requestedDeliveryDate = '2026-09-13'): OrderIntentResult => ({ intent: 'offer_quote', reason: 'test decision', lines: GOLDEN_LINES, requestedDeliveryDate });
export const wingsOffer = (requestedDeliveryDate = '2026-09-13'): OrderIntentResult => ({ intent: 'offer_quote', reason: 'test decision', lines: [{ query: 'Wings', quantity: 2, uom: 'CTN' }], requestedDeliveryDate });
export const prepareQuote: OrderIntentResult = { intent: 'prepare_quote', reason: 'test decision' };
export const acceptQuote: OrderIntentResult = { intent: 'accept_quote', reason: 'test decision' };
export const rejectQuote: OrderIntentResult = { intent: 'reject_quote', reason: 'test decision' };
export const clarify: OrderIntentResult = { intent: 'clarify', reason: 'test decision' };

/** Test-only semantic model. The wording is intentionally ignored; decisions are predeclared. */
export function scriptedSemanticAgentFactory(decisions: readonly OrderIntentResult[]): OrderSemanticAgentFactory {
  let next = 0;
  return asyncFactory;
  function asyncFactory(handler: (intent: OrderIntentResult) => Promise<unknown>) {
    return {
      async run(_text: string) {
        const decision = decisions[next++];
        if (!decision) throw new Error('SCRIPTED_SEMANTIC_DECISION_EXHAUSTED');
        await handler(decision);
        return decision;
      },
    };
  }
}
