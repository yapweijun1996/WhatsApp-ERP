# Owner-operated QR pairing

`POST /api/channel/pairing` is a narrowly scoped exception to paused HTTP write blocking. It only reconnects the unofficial QR transport. It never processes inbox messages, reconciles queued outbound, calls a model, modifies V2 authority or grants staff access. Paused commerce behavior is unchanged.

Enable only with the existing Access issuer, application audience, exact owner email and public HTTPS origin configured as `PAIRING_ACCESS_ISSUER`, `PAIRING_ACCESS_AUDIENCE`, `PAIRING_OWNER_EMAIL`, `PAIRING_PUBLIC_ORIGIN`. The existing Cloudflare Access JWT is verified in memory using issuer public certificates, RS256 signature, audience, expiry and exact owner identity. Missing/invalid config or session fails closed; no new credentials or grants are created. Do not trust email headers or decode-only JWT claims.

Browser requests require the exact Origin and `x-waerp-pairing-action: regenerate`; concurrent/rapid clicks are bounded. Connected accounts are never disconnected by this action, and auth/session files are never deleted. Failure responses are fixed codes without secret/provider-error contents. Status is no-store and returns only a currently connecting, unexpired QR; disconnect/expiry hides stale codes. The UI offers Regenerate QR/Reconnect, pending/error/retry states and explicit pairing-only processing status.

Owner continuation is Air-only. Only the old `whatsapp-erp-runtime.service` inside VM was stopped; VM/VMMCP were not stopped. Preserve old code, data, sessions and backups; no deletion is authorized. Do not restart the VM ERP by default. After owner pairing, active V2/AI/outbound scope remains a separate decision.
