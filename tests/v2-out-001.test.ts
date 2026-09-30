import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommerceService } from '../src/commerce.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { SimulatedChannel } from '../src/channels.js';

test('OUT-001 exposes one durable outbound owner and commerce delegates quotation send/reconcile', () => {
  const commerce = readFileSync('src/commerce.ts', 'utf8');
  assert.match(commerce, /OutboundMessageService/);
  assert.match(commerce, /this\.outbound\.sendQuotation/);
  assert.match(commerce, /this\.outbound\.reconcile/);
  assert.doesNotMatch(commerce, /INSERT INTO outbound_messages|UPDATE outbound_messages|SELECT .* FROM outbound_messages/i);
  assert.equal(OutboundMessageService.name, 'OutboundMessageService');
});

test('OUT-001 keeps quotation finalization trusted and outside outbound business authority', () => {
  const source = readFileSync('src/outbound-message-service.ts', 'utf8');
  assert.match(source, /QuotationSubmittedFinalizer/);
  assert.doesNotMatch(source, /SALES_ORDER|ACCEPTED|create_sales_order|postSalesOrder|confirmSalesOrder|createDeliveryOrder/);
  assert.match(source, /status='SUBMITTED'/);
  assert.match(source, /status='UNKNOWN'/);
  assert.match(source, /retryable:not_found/);
});

test('OUT-001 service is the CommerceService outbound dependency', () => {
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(undefined, channel);
  assert.ok(commerce.outbound instanceof OutboundMessageService);
});
