# Paused migration startup

`createApp({startupMode:'paused'})` is an explicit operator staging mode. The default remains `active`.

Paused mode does not connect the channel, reconcile historical outbound records, or deliver inbound messages to commerce. It returns HTTP 503 `MIGRATION_RUNTIME_PAUSED` for POST/PUT/PATCH/DELETE, including staff session/actions, reset and simulated inbound. Read-only preview routes remain available under the existing whole-host Access protection. `/health.startupMode` reports `paused`.

Use a working copy of an owner-approved consistent private database snapshot; retain the pristine snapshot for verification/rollback. This mode does not grant rollout or migration authority, activate V3, supply model credentials, or authorize messages. Provider connection, owner QR and active processing remain separate controlled cutover steps. Existing quote/acceptance/draft/staff lifecycle semantics are unchanged.
