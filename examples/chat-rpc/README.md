# chat-rpc

`POST /chat/:sessionId` forwards a user turn to a native `Assistant extends Think` Durable Object via `Think.chat()`, collects streamed text deltas, and returns JSON. The live probe sends two turns to one session and requires turn two to recall the unique word from turn one.

Source: [`../../src/worker.ts`](../../src/worker.ts)
