# durable-submit

`POST /submit/:sessionId` invokes Think `submitMessages()` with an idempotency key. That endpoint returns durable acceptance immediately. The probe polls `GET /submit/:sessionId/inspect/:submissionId` until `inspectSubmission()` reports `completed`.

Source: [`../../src/worker.ts`](../../src/worker.ts)
