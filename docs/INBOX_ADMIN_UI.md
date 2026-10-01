# Inbox-first admin UI

The conversation list, selected chat and canonical customer/order detail share one account-scoped selection. `GET /api/conversations` is a read-only projection; `GET /api/state?conversationId=...` and matching trace selection reject unknown or cross-account IDs. No identity is assigned or changed. Existing commerce handlers and staff authorization stay intact. Selected messages, customer, quotation/order, audit and AI trace must all use the same conversation; stale asynchronous responses must never update a later selection.

Desktop: slim navigation, list, chat, contextual detail. Tablet: detail drawer. Mobile: list → chat → detail with explicit back navigation, history, focus and scroll restoration. Connection/owner QR and staff access live in Settings; trace, workspace and audit in Activity. Unread status, presence, attachments, edits and AI toggles are not invented from concept imagery. Actual paused/disabled state remains prominent; the real WhatsApp composer is disabled because no manual-send API is authorized. Legacy synthetic controls stay secondary and are shown only for active simulated transport.

Owner QR reuses the verified Access-session endpoint and private session handling unchanged. No pairing, model call, authority activation, order write, customer reassignment or outbound message occurs during QA. Tests and screenshots use only marked synthetic fixtures; the Library reference is a fictional visual concept, not proof of runtime capabilities.

## Validation

1,026 offline tests and 12 portable browser tests pass. Browser coverage includes desktop stale-response isolation, canonical customer/order selection, mobile back/history/focus and overflow, tablet context drawer, list error/retry/search/empty states, existing staff login, paused controls and owner QR status/retry. Two additional local captures compare the previous layout using the same marked synthetic fixtures. Typecheck, build, JavaScript syntax checks, diff checks and a redacted Gitleaks scan pass.

No physical WhatsApp pairing, paid inference, production writes or outbound messages were tested. Publishing this UI does not enable processing; the protected origin must retain paused startup, disabled AI/V2 and blocked outbound.

## Interface icons

Owner preference: all interface icons use SVG. A local stroke/currentColor sprite replaces navigation, search, info, back, close, send and disclosure font glyphs. Icon-only controls retain accessible names; graphics are decorative and unfocusable. Brand initials, canonical customer avatars, QR images and message content are retained. This static-only change does not alter authentication, pairing, runtime processing or commerce.
