import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import * as z from "zod/v4";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const apiToken = process.env.MAILPACE_API_TOKEN;
const organizationToken = process.env.MAILPACE_ORGANIZATION_TOKEN;

if (!apiToken && !organizationToken) {
  console.error(
    "No API token provided. Set MAILPACE_API_TOKEN (to send email) and/or " +
      "MAILPACE_ORGANIZATION_TOKEN (to manage domains)."
  );
  process.exit(1);
}

function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid MAILPACE_API_URL: ${value}`);
  }

  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error(
      "MAILPACE_API_URL must use HTTPS, except for localhost development URLs"
    );
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

let API_BASE_URL: string;
try {
  API_BASE_URL = normalizeApiBaseUrl(
    process.env.MAILPACE_API_URL || "https://app.mailpace.com/api/v1"
  );
} catch (error: any) {
  console.error(error.message);
  process.exit(1);
}
const REQUEST_TIMEOUT_MS = Number(
  process.env.MAILPACE_REQUEST_TIMEOUT_MS || 30_000
);
const MAX_RETRIES = Number(process.env.MAILPACE_MAX_RETRIES ?? 2);

const server = new McpServer(
  {
    name: "mailpace",
    version,
  },
  {
    instructions:
      "MailPace provides transactional email sending and domain management. " +
      "MAILPACE_API_TOKEN enables send-email and email status lookups for one domain. " +
      "MAILPACE_ORGANIZATION_TOKEN enables domain and domain API token management. " +
      "Sending email is an external side effect; confirm recipients before calling send-email.",
    maxToolInputElements: 10_000,
  }
);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const domainSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    url: z.string(),
    dkim_selector: z.string().nullable().optional(),
    dkim_string: z.string().nullable().optional(),
    dkim_verified: z.boolean(),
    advanced_verified: z.boolean(),
    webhook_public_key: z.string().nullable().optional(),
    created_at: z.string(),
    modified_at: z.string(),
  })
  .passthrough();

const domainListSchema = z.object({
  domains: z.array(domainSchema),
});

const verifyDomainSchema = z
  .object({
    dkim_verified: z.boolean(),
    advance_verified: z.boolean(),
    errors: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const apiTokenSchema = z
  .object({
    id: z.number().int().optional(),
    domain_id: z.number().int().optional(),
    name: z.string().nullable().optional(),
    token: z.string().optional(),
    created_at: z.string().optional(),
    modified_at: z.string().optional(),
  })
  .passthrough();

const apiTokenListSchema = z.object({
  api_tokens: z.array(apiTokenSchema),
});

const messageSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

const emailStatusSchema = z
  .object({
    id: z.number().int(),
    domain_id: z.number().int(),
    status: z.string(),
    message_id: z.string().nullable().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    cc: z.string().nullable().optional(),
    bcc: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    replyto: z.string().nullable().optional(),
    inreplyto: z.string().nullable().optional(),
    references: z.string().nullable().optional(),
    list_unsubscribe: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    bounce_reason: z.string().nullable().optional(),
    bounce: z.record(z.string(), z.unknown()).nullable().optional(),
    deferred: z.record(z.string(), z.unknown()).nullable().optional(),
    created_at: z.string().optional(),
    modified_at: z.string().optional(),
  })
  .passthrough();

const sendEmailSchema = z.object({
  id: z.number().int(),
  status: z.string(),
});

const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ATTACHMENT_EXTENSIONS = new Set([
  "jpeg",
  "jpg",
  "png",
  "gif",
  "txt",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "att",
  "ics",
  "ical",
  "html",
  "zip",
  "auf",
  "xml",
  "dwg",
]);
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "<" && !inQuotes) {
      angleDepth += 1;
    } else if (char === ">" && !inQuotes) {
      angleDepth = Math.max(0, angleDepth - 1);
    }

    if (char === "," && !inQuotes && angleDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function isValidAddress(value: string): boolean {
  const trimmed = value.trim();
  const angleMatch = trimmed.match(/^.*<([^<>]+)>$/);
  const address = (angleMatch ? angleMatch[1] : trimmed).trim();
  return EMAIL_ADDRESS_RE.test(address);
}

const emailAddressSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidAddress, {
    message:
      "Must be an email address or an RFC 822 name & addr-spec, for example 'Name <user@example.com>'",
  });

const emailListSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      const addresses = splitAddressList(value);
      return addresses.length > 0 && addresses.every(isValidAddress);
    },
    {
      message:
        "Must be a comma-separated list of email addresses or RFC 822 name & addr-spec entries",
    }
  );

const attachmentSchema = z.object({
  name: z
    .string()
    .min(1)
    .refine(
      (name) => {
        const parts = name.split(".");
        return (
          parts.length === 2 &&
          ATTACHMENT_EXTENSIONS.has(parts[1].toLowerCase())
        );
      },
      {
        message:
          "File names must have exactly one full stop and use a supported extension",
      }
    )
    .describe(
      "File name including extension, for example invoice.pdf. Must contain exactly one full stop."
    ),
  content: z.string().min(1).describe("Base64-encoded file contents"),
  content_type: z
    .string()
    .min(1)
    .describe("MIME type, for example application/pdf"),
  cid: z
    .string()
    .optional()
    .describe("Optional content ID for inline images"),
});

const sendEmailInputSchema = z
  .object({
    from: emailAddressSchema.describe(
      "Sender email address or RFC 822 name & addr-spec, for example 'Name <user@example.com>'. The domain must match the API token."
    ),
    to: emailListSchema.describe(
      "Recipient address or comma-separated list of recipients (maximum 50 total including cc and bcc)"
    ),
    subject: z.string().optional().describe("Email subject"),
    htmlbody: z
      .string()
      .optional()
      .describe("HTML body. Required if textbody is not provided."),
    textbody: z
      .string()
      .optional()
      .describe("Plain-text body. Required if htmlbody is not provided."),
    cc: emailListSchema
      .optional()
      .describe("Optional comma-separated CC recipients"),
    bcc: emailListSchema
      .optional()
      .describe("Optional comma-separated BCC recipients"),
    replyto: emailAddressSchema
      .optional()
      .describe("Optional Reply-To address"),
    inreplyto: z
      .string()
      .optional()
      .describe("Optional In-Reply-To message ID"),
    references: z
      .string()
      .optional()
      .describe("Optional space-separated References message IDs"),
    list_unsubscribe: z
      .string()
      .optional()
      .describe("Optional List-Unsubscribe header value"),
    attachments: z
      .array(attachmentSchema)
      .optional()
      .describe("Optional attachments. Total email size must not exceed 30 MB."),
    tags: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Optional tag or list of tags for filtering and analytics"),
    idempotency_key: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Optional unique key (for example a UUIDv4) that prevents sending the same email twice when retrying"
      ),
  })
  .superRefine((value, ctx) => {
    if (!value.textbody && !value.htmlbody) {
      ctx.addIssue({
        code: "custom",
        message: "Either textbody or htmlbody must be provided",
        path: ["textbody"],
      });
    }

    const recipients = [value.to, value.cc, value.bcc]
      .filter((address): address is string => Boolean(address))
      .flatMap(splitAddressList);

    if (recipients.length > MAX_RECIPIENTS) {
      ctx.addIssue({
        code: "custom",
        message: `A maximum of ${MAX_RECIPIENTS} recipients is allowed`,
        path: ["to"],
      });
    }

    const attachmentBytes = (value.attachments ?? []).reduce(
      (total, attachment) =>
        total + Math.ceil((attachment.content.length * 3) / 4),
      0
    );

    if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "Attachments must not exceed 30 MB in total",
        path: ["attachments"],
      });
    }
  });

function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ success: false, error: message }, null, 2),
      },
    ],
    isError: true,
  };
}

type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  token: string;
  tokenHeader: "MailPace-Organization-Token" | "MailPace-Server-Token";
  signal?: AbortSignal;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("MailPace API request cancelled"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("MailPace API request cancelled"));
      },
      { once: true }
    );
  });
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  return Math.min(1000 * 2 ** attempt, 10_000);
}

async function apiRequest(
  path: string,
  options: ApiRequestOptions
): Promise<unknown> {
  const url = `${API_BASE_URL}${path}`;
  const method = options.method || "GET";
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const isIdempotent =
    ["GET", "HEAD", "PATCH", "DELETE"].includes(method) ||
    Boolean(options.headers?.["Idempotency-Key"]);

  for (let attempt = 0; ; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [options.tokenHeader]: options.token,
          ...options.headers,
        },
        body,
        signal,
      });
    } catch (error: any) {
      if (options.signal?.aborted) {
        throw new Error("MailPace API request cancelled");
      }
      if (error?.name === "TimeoutError") {
        throw new Error(
          `MailPace API request timed out after ${REQUEST_TIMEOUT_MS}ms`
        );
      }

      const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
      const message = `${error?.message || "Network request failed"}${cause}`;

      if (isIdempotent && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt), options.signal);
        continue;
      }

      throw new Error(`MailPace API request failed: ${message}`);
    }

    const responseText = await response.text();
    let data: unknown = null;

    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }
    }

    if (response.ok) {
      return data;
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_RETRIES &&
      (isIdempotent || response.status === 429)
    ) {
      await sleep(retryDelayMs(attempt, response), options.signal);
      continue;
    }

    let detail = responseText;
    if (data && typeof data === "object") {
      const errorData = data as Record<string, unknown>;
      detail = String(
        errorData.error || errorData.message || JSON.stringify(data)
      );
    }
    throw new Error(
      `MailPace API request failed (${response.status} ${
        response.statusText
      }): ${detail || "Unknown error"}`
    );
  }
}

function organizationRequest(
  path: string,
  options: Omit<ApiRequestOptions, "token" | "tokenHeader"> = {}
): Promise<unknown> {
  return apiRequest(path, {
    ...options,
    token: organizationToken as string,
    tokenHeader: "MailPace-Organization-Token",
  });
}

function serverRequest(
  path: string,
  options: Omit<ApiRequestOptions, "token" | "tokenHeader"> = {}
): Promise<unknown> {
  return apiRequest(path, {
    ...options,
    token: apiToken as string,
    tokenHeader: "MailPace-Server-Token",
  });
}

async function runApiTool(
  operation: () => Promise<unknown>,
  label = "MailPace API"
): Promise<ToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error: any) {
    console.error(`${label} error: ${error.message}`);
    return errorResult(error.message || String(error));
  }
}

function runOrganizationTool(
  operation: () => Promise<unknown>
): Promise<ToolResult> {
  return runApiTool(operation, "MailPace Domains API");
}

// Define the email tool
if (apiToken) {
  server.registerTool(
    "mailpace_send_email",
    {
      title: "Send Email",
      description:
        "Send a transactional email through MailPace. Requires a domain API token.",
      inputSchema: sendEmailInputSchema,
      outputSchema: sendEmailSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ idempotency_key, ...email }, ctx) => {
      try {
        const result = (await serverRequest("/send", {
          method: "POST",
          body: email,
          headers: idempotency_key
            ? { "Idempotency-Key": idempotency_key }
            : undefined,
          signal: ctx.mcpReq.signal,
        })) as { id: number; status: string };

        return jsonResult({ id: result.id, status: result.status });
      } catch (error: any) {
        console.error(`Error sending email: ${error.message}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message: "Failed to send email",
                  error: error.message,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// Email status can be read with either an organization token or the
// domain's server token.
if (apiToken || organizationToken) {
  server.registerTool(
    "mailpace_get_email_status",
    {
      title: "Get Email Status",
      description:
        "Get the delivery status of an email, including bounce or deferral details.",
      inputSchema: z.object({
        domain_id: z
          .number()
          .int()
          .describe("ID of the domain the email was sent from"),
        id: z
          .number()
          .int()
          .describe("Email ID returned by mailpace_send_email"),
      }),
      outputSchema: emailStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain_id, id }, ctx) =>
      runApiTool(
        () =>
          organizationToken
            ? organizationRequest(`/domains/${domain_id}/emails/${id}`, {
                signal: ctx.mcpReq.signal,
              })
            : serverRequest(`/domains/${domain_id}/emails/${id}`, {
                signal: ctx.mcpReq.signal,
              }),
        "MailPace Email Status API"
      )
  );
}

// Domains API tools. These require an Organization API token.
if (organizationToken) {
  server.registerTool(
    "mailpace_list_domains",
    {
      title: "List Domains",
      description: "List the domains belonging to your MailPace organization.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        sort: z.enum(["created_at", "id", "name"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
      }),
      outputSchema: domainListSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, offset, sort, direction }, ctx) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      if (sort !== undefined) params.set("sort", sort);
      if (direction !== undefined) params.set("direction", direction);

      const query = params.toString();
      return runOrganizationTool(async () => ({
        domains: await organizationRequest(
          `/domains${query ? `?${query}` : ""}`,
          { signal: ctx.mcpReq.signal }
        ),
      }));
    }
  );

  server.registerTool(
    "mailpace_get_domain",
    {
      title: "Get Domain",
      description: "Get a single MailPace domain by ID.",
      inputSchema: z.object({
        id: z.number().int().describe("The domain ID"),
      }),
      outputSchema: domainSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${id}`, { signal: ctx.mcpReq.signal })
      )
  );

  server.registerTool(
    "mailpace_create_domain",
    {
      title: "Create Domain",
      description: "Create a new sending domain in your MailPace organization.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("Lower-case domain with TLD, for example example.com"),
        name: z.string().optional().describe("Friendly name for your reference"),
      }),
      outputSchema: domainSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, name }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest("/domains", {
          method: "POST",
          body: { domain: { url, ...(name !== undefined ? { name } : {}) } },
          signal: ctx.mcpReq.signal,
        })
      )
  );

  server.registerTool(
    "mailpace_update_domain",
    {
      title: "Update Domain",
      description:
        "Update the name or URL of a MailPace domain. Changing the URL may require DNS verification again.",
      inputSchema: z.object({
        id: z.number().int().describe("The domain ID"),
        name: z.string().optional().describe("Friendly name for your reference"),
        url: z
          .string()
          .optional()
          .describe("Lower-case domain with TLD, for example example.com"),
      }),
      outputSchema: domainSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, name, url }, ctx) => {
      if (name === undefined && url === undefined) {
        return errorResult("Provide at least one of name or url to update");
      }

      return runOrganizationTool(() =>
        organizationRequest(`/domains/${id}`, {
          method: "PATCH",
          body: {
            domain: {
              ...(name !== undefined ? { name } : {}),
              ...(url !== undefined ? { url } : {}),
            },
          },
          signal: ctx.mcpReq.signal,
        })
      );
    }
  );

  server.registerTool(
    "mailpace_verify_domain",
    {
      title: "Verify Domain",
      description:
        "Check the DKIM and advanced verification DNS records for a MailPace domain.",
      inputSchema: z.object({
        id: z.number().int().describe("The domain ID"),
      }),
      outputSchema: verifyDomainSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${id}/verify`, {
          method: "POST",
          signal: ctx.mcpReq.signal,
        })
      )
  );

  server.registerTool(
    "mailpace_list_domain_api_tokens",
    {
      title: "List Domain API Tokens",
      description: "List the API tokens for a MailPace domain.",
      inputSchema: z.object({
        domain_id: z.number().int().describe("The domain ID"),
      }),
      outputSchema: apiTokenListSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain_id }, ctx) =>
      runOrganizationTool(async () => ({
        api_tokens: await organizationRequest(
          `/domains/${domain_id}/api_tokens`,
          { signal: ctx.mcpReq.signal }
        ),
      }))
  );

  server.registerTool(
    "mailpace_get_domain_api_token",
    {
      title: "Get Domain API Token",
      description: "Get a single API token for a MailPace domain.",
      inputSchema: z.object({
        domain_id: z.number().int().describe("The domain ID"),
        id: z.number().int().describe("The API token ID"),
      }),
      outputSchema: apiTokenSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain_id, id }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`, {
          signal: ctx.mcpReq.signal,
        })
      )
  );

  server.registerTool(
    "mailpace_create_domain_api_token",
    {
      title: "Create Domain API Token",
      description:
        "Create a new API token for a MailPace domain. Store the returned token securely; it may not be shown again.",
      inputSchema: z.object({
        domain_id: z.number().int().describe("The domain ID"),
        name: z.string().optional().describe("Friendly token label"),
      }),
      outputSchema: apiTokenSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ domain_id, name }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens`, {
          method: "POST",
          body: { api_token: { ...(name !== undefined ? { name } : {}) } },
          signal: ctx.mcpReq.signal,
        })
      )
  );

  server.registerTool(
    "mailpace_update_domain_api_token",
    {
      title: "Update Domain API Token",
      description: "Update the name of an API token for a MailPace domain.",
      inputSchema: z.object({
        domain_id: z.number().int().describe("The domain ID"),
        id: z.number().int().describe("The API token ID"),
        name: z.string().optional().describe("Friendly token label"),
      }),
      outputSchema: apiTokenSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain_id, id, name }, ctx) => {
      if (name === undefined) {
        return errorResult("Provide a name to update the API token");
      }

      return runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`, {
          method: "PATCH",
          body: { api_token: { name } },
          signal: ctx.mcpReq.signal,
        })
      );
    }
  );

  server.registerTool(
    "mailpace_revoke_domain_api_token",
    {
      title: "Revoke Domain API Token",
      description:
        "Revoke an API token for a MailPace domain. This cannot be undone.",
      inputSchema: z.object({
        domain_id: z.number().int().describe("The domain ID"),
        id: z.number().int().describe("The API token ID"),
      }),
      outputSchema: messageSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain_id, id }, ctx) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`, {
          method: "DELETE",
          signal: ctx.mcpReq.signal,
        })
      )
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `MailPace MCP Server running on stdio (email sending: ${
      apiToken ? "enabled" : "disabled"
    }, domain management: ${organizationToken ? "enabled" : "disabled"})`
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
