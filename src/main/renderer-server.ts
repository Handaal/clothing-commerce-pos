import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { PRODUCTION_RENDERER_ORIGIN, rendererFilePath } from "./renderer-origin";

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export async function startRendererServer(rendererRoot: string): Promise<Server> {
  const origin = new URL(PRODUCTION_RENDERER_ORIGIN);
  const server = createServer(async (request, response) => {
    if (request.headers.host !== origin.host || !["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(404).end();
      return;
    }

    const filePath = rendererFilePath(rendererRoot, request.url ?? "/");
    if (filePath === null) {
      response.writeHead(404).end();
      return;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": fileStat.size,
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' https:; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https:; img-src 'self' data: https:; frame-src https:; font-src 'self' https:; object-src 'none'; base-uri 'self'; form-action https:",
        "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}
