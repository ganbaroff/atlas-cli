/**
 * atlas/model-broker/mock-upstream.ts — TEST-ONLY loopback mock upstream.
 *
 * This is a stand-in for a real model provider's chat.completions endpoint,
 * used only by this package's own tests to exercise server.ts's forwarding
 * path without a real network call. It must NEVER be pointed at by
 * BrokerConfig.upstreamUrl in anything but a test — it has no auth, no rate
 * limiting, and returns a fixed canned response regardless of input.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockUpstream {
  readonly server: Server;
  hits(): number;
  readonly url: string;
}

/** Binds 127.0.0.1 on an ephemeral port; caller must server.close() when done. TEST-ONLY — see module header. */
export function createMockUpstream(): Promise<MockUpstream> {
  return new Promise((resolve) => {
    let hitCount = 0;
    const server = createServer((req, res) => {
      hitCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          id: 'mock-completion',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'mock response' },
              finish_reason: 'stop',
            },
          ],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        hits: () => hitCount,
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      });
    });
  });
}
