import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, test } from "node:test";

const PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT_MS = 5_000;

function createHarness({ env = {}, onRequest } = {}) {
  const requests = [];
  let requestCount = 0;

  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const parsedBody = body ? JSON.parse(body) : undefined;
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      });
      requestCount += 1;

      try {
        const result =
          (await onRequest?.(req, parsedBody, requestCount)) ?? {
            status: 200,
            body: {},
          };
        res.statusCode = result.status ?? 200;
        res.setHeader("Content-Type", result.contentType ?? "application/json");
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
        if (result.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, result.delayMs));
        }
        res.end(
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? {})
        );
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address();
      const childEnv = { ...process.env };
      for (const key of [
        "MAILPACE_API_TOKEN",
        "MAILPACE_ORGANIZATION_TOKEN",
        "MAILPACE_API_URL",
        "MAILPACE_ALLOWED_RECIPIENTS",
        "MAILPACE_REQUEST_TIMEOUT_MS",
        "MAILPACE_MAX_RETRIES",
      ]) {
        delete childEnv[key];
      }
      Object.assign(childEnv, {
        MAILPACE_API_URL: `http://127.0.0.1:${port}/api/v1`,
        ...env,
      });

      const child = spawn(process.execPath, ["build/index.js"], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let buffer = "";
      let stderr = "";
      let nextId = 1;
      const pending = new Map();

      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code, signal) => {
        for (const { reject: rejectRequest } of pending.values()) {
          rejectRequest(
            new Error(
              `Server exited before responding (code=${code}, signal=${signal})`
            )
          );
        }
        pending.clear();
      });

      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;

          const message = JSON.parse(line);
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            clearTimeout(entry.timer);
            entry.resolve(message);
          }
        }
      });

      function send(method, params) {
        const id = nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectRequest(
              new Error(
                `Timed out waiting for ${method}. Server stderr: ${stderr}`
              )
            );
          }, REQUEST_TIMEOUT_MS);

          pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
          );
        });
      }

      function notify(method, params) {
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
        );
      }

      const harness = {
        requests,
        stderr: () => stderr,
        initialize: async () => {
          const result = await send("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "mailpace-mcp-test", version: "1.0.0" },
          });
          notify("notifications/initialized", {});
          return result;
        },
        listTools: async () => {
          const result = await send("tools/list", {});
          return result.result.tools;
        },
        callTool: async (name, args) => {
          const result = await send("tools/call", {
            name,
            arguments: args,
          });
          return result.result;
        },
        close: () =>
          new Promise((resolveClose) => {
            child.once("exit", resolveClose);
            child.kill();
            httpServer.close();
          }),
      };

      resolve(harness);
    });
  });
}

const domain = {
  id: 9,
  name: "Production",
  url: "example.com",
  dkim_selector: "mailpace",
  dkim_string: "k=rsa; p=abc",
  dkim_verified: true,
  advanced_verified: true,
  webhook_public_key: "public-key",
  created_at: "2026-01-01T00:00:00Z",
  modified_at: "2026-01-01T00:00:00Z",
};

const emailStatus = {
  id: 456,
  domain_id: 9,
  status: "delivered",
  message_id: "<message@example.com>",
  from: "hello@example.com",
  to: "a@example.com",
  cc: null,
  bcc: null,
  subject: "Hi",
  replyto: null,
  inreplyto: null,
  references: null,
  list_unsubscribe: null,
  tags: [],
  bounce_reason: null,
  bounce: null,
  deferred: null,
  created_at: "2026-01-01T00:00:00Z",
  modified_at: "2026-01-01T00:00:00Z",
};

const harnesses = [];
async function harness(options) {
  const instance = await createHarness(options);
  harnesses.push(instance);
  await instance.initialize();
  return instance;
}

after(async () => {
  await Promise.all(harnesses.map((instance) => instance.close()));
});

test("registers all tools when both tokens are present", async () => {
  const server = await harness({
    env: {
      MAILPACE_API_TOKEN: "domain-token",
      MAILPACE_ORGANIZATION_TOKEN: "org-token",
    },
  });

  const names = (await server.listTools()).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "mailpace_create_domain",
    "mailpace_create_domain_api_token",
    "mailpace_get_domain",
    "mailpace_get_domain_api_token",
    "mailpace_get_email_status",
    "mailpace_list_domain_api_tokens",
    "mailpace_list_domains",
    "mailpace_revoke_domain_api_token",
    "mailpace_send_email",
    "mailpace_update_domain",
    "mailpace_update_domain_api_token",
    "mailpace_verify_domain",
  ]);
});

test("registers only domain tools in organization-only mode", async () => {
  const server = await harness({
    env: { MAILPACE_ORGANIZATION_TOKEN: "org-token" },
  });

  const names = (await server.listTools()).map((tool) => tool.name);
  assert.ok(names.includes("mailpace_list_domains"));
  assert.ok(names.includes("mailpace_get_email_status"));
  assert.ok(!names.includes("mailpace_send_email"));
});

test("registers only send and status tools in domain-only mode", async () => {
  const server = await harness({
    env: { MAILPACE_API_TOKEN: "domain-token" },
  });

  const names = (await server.listTools()).map((tool) => tool.name);
  assert.ok(names.includes("mailpace_send_email"));
  assert.ok(names.includes("mailpace_get_email_status"));
  assert.ok(!names.includes("mailpace_list_domains"));
});

test("sends email with display-name addresses and idempotency key", async () => {
  const server = await harness({
    env: { MAILPACE_API_TOKEN: "domain-token" },
    onRequest: () => ({ status: 200, body: { id: 456, status: "queued" } }),
  });

  const result = await server.callTool("mailpace_send_email", {
    from: "Full Name <hello@example.com>",
    to: "Recipient <a@example.com>, b@example.com",
    subject: "Hi",
    textbody: "Hello",
    idempotency_key: "abc-123",
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { id: 456, status: "queued" });

  const request = server.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/v1/send");
  assert.equal(request.headers["mailpace-server-token"], "domain-token");
  assert.equal(request.headers["idempotency-key"], "abc-123");
  assert.deepEqual(request.body, {
    from: "Full Name <hello@example.com>",
    to: "Recipient <a@example.com>, b@example.com",
    subject: "Hi",
    textbody: "Hello",
  });
});

test("rejects an email without a text or HTML body before calling the API", async () => {
  const server = await harness({
    env: { MAILPACE_API_TOKEN: "domain-token" },
    onRequest: () => ({ status: 200, body: { id: 456, status: "queued" } }),
  });

  const result = await server.callTool("mailpace_send_email", {
    from: "hello@example.com",
    to: "a@example.com",
    subject: "Hi",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /textbody or htmlbody/i);
  assert.equal(server.requests.length, 0);
});

test("enforces the recipient allowlist", async () => {
  const server = await harness({
    env: {
      MAILPACE_API_TOKEN: "domain-token",
      MAILPACE_ALLOWED_RECIPIENTS: "@example.com",
    },
    onRequest: () => ({ status: 200, body: { id: 456, status: "queued" } }),
  });

  const result = await server.callTool("mailpace_send_email", {
    from: "hello@example.com",
    to: "blocked@elsewhere.test",
    textbody: "Hello",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not permitted/);
  assert.equal(server.requests.length, 0);
});

test("uses the expected request shapes for domain operations", async () => {
  const server = await harness({
    env: { MAILPACE_ORGANIZATION_TOKEN: "org-token" },
    onRequest: (req, body) => {
      if (req.method === "GET" && req.url.startsWith("/api/v1/domains?")) {
        return { status: 200, body: [domain] };
      }
      if (req.method === "GET" && req.url.startsWith("/api/v1/domains/9/api_tokens")) {
        return { status: 200, body: [{ id: 7, name: "Sender key" }] };
      }
      if (req.url === "/api/v1/domains/9/verify") {
        return { status: 200, body: { dkim_verified: false, advance_verified: false } };
      }
      if (req.method === "DELETE") {
        return { status: 200, body: { message: "Token revoked" } };
      }
      if (req.method === "POST" && body?.api_token) {
        return { status: 201, body: { id: 7, ...body.api_token } };
      }
      return { status: 200, body: domain };
    },
  });

  const listResult = await server.callTool("mailpace_list_domains", {
    limit: 10,
    offset: 5,
    sort: "name",
    direction: "asc",
  });
  assert.deepEqual(listResult.structuredContent, { domains: [domain] });

  await server.callTool("mailpace_create_domain", {
    url: "example.com",
    name: "Production",
  });
  await server.callTool("mailpace_update_domain", {
    id: 9,
    name: "Production EU",
  });
  await server.callTool("mailpace_verify_domain", { id: 9 });
  await server.callTool("mailpace_list_domain_api_tokens", { domain_id: 9 });
  await server.callTool("mailpace_create_domain_api_token", {
    domain_id: 9,
    name: "Sender key",
  });
  await server.callTool("mailpace_revoke_domain_api_token", {
    domain_id: 9,
    id: 7,
  });

  assert.deepEqual(
    server.requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET /api/v1/domains?limit=10&offset=5&sort=name&direction=asc",
      "POST /api/v1/domains",
      "PATCH /api/v1/domains/9",
      "POST /api/v1/domains/9/verify",
      "GET /api/v1/domains/9/api_tokens",
      "POST /api/v1/domains/9/api_tokens",
      "DELETE /api/v1/domains/9/api_tokens/7",
    ]
  );

  assert.deepEqual(server.requests[1].body, {
    domain: { url: "example.com", name: "Production" },
  });
  assert.deepEqual(server.requests[2].body, {
    domain: { name: "Production EU" },
  });
  assert.deepEqual(server.requests[5].body, {
    api_token: { name: "Sender key" },
  });
});

test("uses the domain server token for email status in domain-only mode", async () => {
  const server = await harness({
    env: { MAILPACE_API_TOKEN: "domain-token" },
    onRequest: () => ({ status: 200, body: emailStatus }),
  });

  const result = await server.callTool("mailpace_get_email_status", {
    domain_id: 9,
    id: 456,
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "delivered");
  assert.equal(server.requests[0].headers["mailpace-server-token"], "domain-token");
});

test("maps API status codes to actionable errors", async () => {
  const server = await harness({
    env: { MAILPACE_ORGANIZATION_TOKEN: "org-token" },
    onRequest: () => ({ status: 422, body: { error: "Url is invalid" } }),
  });

  const result = await server.callTool("mailpace_create_domain", {
    url: "not a domain",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /422/);
  assert.match(result.content[0].text, /Url is invalid/);
});

test("retries 429 responses that include Retry-After", async () => {
  const server = await harness({
    env: {
      MAILPACE_ORGANIZATION_TOKEN: "org-token",
      MAILPACE_MAX_RETRIES: "2",
    },
    onRequest: (req, body, count) => {
      if (count === 1) {
        return {
          status: 429,
          body: { error: "Slow down" },
          headers: { "Retry-After": "0" },
        };
      }
      return { status: 200, body: [domain] };
    },
  });

  const result = await server.callTool("mailpace_list_domains", {});

  assert.equal(result.isError, undefined);
  assert.equal(server.requests.length, 2);
});

test("times out stalled API requests", async () => {
  const server = await harness({
    env: {
      MAILPACE_ORGANIZATION_TOKEN: "org-token",
      MAILPACE_REQUEST_TIMEOUT_MS: "50",
    },
    onRequest: () => ({
      status: 200,
      body: [domain],
      delayMs: 500,
    }),
  });

  const result = await server.callTool("mailpace_list_domains", {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timed out/i);
});
