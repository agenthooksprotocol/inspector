import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

export type Handler = (request: RecordedRequest, response: ServerResponse) => void;

export interface TestHttpServer {
  url: string;
  requests: RecordedRequest[];
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

/** Configurable loopback HTTP server for exercising the real HTTP boundary. */
export function startHttpServer(initialHandler?: Handler): Promise<TestHttpServer> {
  const requests: RecordedRequest[] = [];
  let handler: Handler = initialHandler ?? ((_request, response) => {
    response.statusCode = 500;
    response.end();
  });

  const server: Server = createServer((incoming, response) => {
    let body = "";
    incoming.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    incoming.on("end", () => {
      const recorded: RecordedRequest = {
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        headers: incoming.headers,
        body,
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${address.port}/hooks`,
        requests,
        setHandler(next: Handler): void {
          handler = next;
        },
        close(): Promise<void> {
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
