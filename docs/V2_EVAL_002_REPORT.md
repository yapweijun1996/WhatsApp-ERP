# V2-EVAL-002 Evaluation Report

Status: **PASS** (deterministic native + Demo bridge evaluation)

Scope is test-only. No external network, real QR WhatsApp, real WhatsApp, Demo GPT, or gateway was used. V2 customer traffic remains **OFF** and the browser surface is available only when `NODE_ENV=test` and `V2_EVAL_002_SURFACE=1`; it is not a production customer route.

Evidence harness: `src/v2-eval-002-harness.ts` reuses `NativeToolTransport`, `DemoTextToolBridge`, canonical decision normalization, and `compareTransportSemanticParity`. Captured state/provenance is the deterministic observation: `demo-account / conv-001 / eval-002-message-001`, WorkItem `eval-002-work-item` revision 3 in `DRAFTING`, OrderDraft `eval-002-draft` revision 2, ERP evidence `eval-002-erp-evidence-001`. Both traces end with `RUNTIME_RESPONSE` and `PI_FINAL_PENDING_GROUNDING`; no business mutation is executed.

Executed evidence:

- `node --import tsx --test tests/v2-eval-002.test.ts tests/v2-native-tool-transport.test.ts tests/v2-demo-text-tool-bridge.test.ts tests/v2-transport-runtime.test.ts tests/v2-transport-contract.test.ts tests/v2-eval-001.test.ts`: **PASS** (79/79 focused deterministic/evaluation/transport tests)
- `NODE_ENV=test V2_EVAL_002_SURFACE=1 node --import tsx ... app.inject(GET /api/test-only/v2-eval-002)`: **PASS** (HTTP 200, evaluation PASS, provenance `eval-002-message-001`)
- `NODE_ENV=test V2_EVAL_002_SURFACE=1 npx playwright test tests/e2e/v2-eval-002.spec.ts --project=chromium`: **PASS** (1/1 Chromium browser integration; HTTP evaluation surface reports semantic parity, captured state/provenance, safety flags, and UI remains `V1_ONLY`)
- `npm run typecheck`: **PASS**

Safety assertions passed: AI cutoff is `SALES_ORDER.DRAFT`; no Sales Order post/confirm or Delivery Order capability is enabled; outbound ownership remains represented as `RUNTIME_RESPONSE`; no live provider or QR path is invoked. This is EVAL-002 evidence only, not live EVAL-003.

Known limitation: this report validates the deterministic transport/bridge host path and a browser request to the test-only surface; real channel/provider behavior is intentionally deferred to EVAL-003.

Final closure evidence:

- Full regression: **433/433 PASS**
- Build: **PASS**
- Full Chromium E2E: **2/2 PASS**
- `npm audit`: **0 vulnerabilities**
- Production environment test-only EVAL-002 route: **404 / closed**
- Independent read-only review: **PASS — P0=0 / P1=0 / P2=0**
