import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/** Real smart-HTTP Git server; verifies the same protocol used by Artifacts. */
export async function gitServer() {
  const root = await mkdtemp(join(tmpdir(), "memory-git-"));
  const command = (...args: string[]) =>
    execFileSync("git", args, { stdio: "pipe" });
  command("init", "--bare", "--initial-branch=main", join(root, "memory.git"));
  command("-C", join(root, "memory.git"), "config", "http.receivepack", "true");
  const auth = `Basic ${Buffer.from("x:test-token").toString("base64")}`;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== auth) {
      res.writeHead(401, { "www-authenticate": "Basic realm=git" });
      res.end();
      return;
    }
    const url = new URL(req.url!, "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        REMOTE_USER: "test",
        SERVER_PROTOCOL: "HTTP/1.1",
      },
    });
    const data: Buffer[] = [];
    backend.stdout.on("data", (part: Buffer) => data.push(part));
    backend.stderr.resume();
    req.pipe(backend.stdin);
    backend.on("close", () => {
      const output = Buffer.concat(data);
      const split = output.indexOf("\r\n\r\n");
      if (split < 0) {
        res.writeHead(500);
        res.end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(output.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    remote: `http://127.0.0.1:${(server.address() as AddressInfo).port}/memory.git`,
    token: "test-token?expires=9999999999",
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
