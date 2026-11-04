import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import MailPace from "@mailpace/mailpace.js";
import minimist from "minimist";

const argv = minimist(process.argv.slice(2));
const apiToken = argv.token || process.env.MAILPACE_API_TOKEN;
const organizationToken =
  argv["organization-token"] || process.env.MAILPACE_ORGANIZATION_TOKEN;

if (!apiToken && !organizationToken) {
  console.error(
    "No API token provided. Set MAILPACE_API_TOKEN (to send email) and/or " +
      "MAILPACE_ORGANIZATION_TOKEN (to manage domains), or pass --token / " +
      "--organization-token."
  );
  process.exit(1);
}

const client = apiToken ? new MailPace.DomainClient(apiToken) : null;

const API_BASE_URL =
  process.env.MAILPACE_API_URL || "https://app.mailpace.com/api/v1";

const server = new McpServer({
  name: "transactional-email-sending-service",
  version: "1.1.0",
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
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

async function organizationRequest(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "MailPace-Organization-Token": organizationToken as string,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const responseText = await response.text();
  let data: unknown = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }

  if (!response.ok) {
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

  return data;
}

async function runOrganizationTool(
  operation: () => Promise<unknown>
): Promise<ToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error: any) {
    console.error(`MailPace Domains API error: ${error.message}`);
    return errorResult(error.message || String(error));
  }
}

// Define the email tool
if (client) {
  server.tool(
    "send-email",
    {
      from: z.string().email(),
      to: z.string(),
      subject: z.string().optional(),
      htmlbody: z.string().optional(),
      textbody: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      replyto: z.string().optional(),
      inreplyto: z.string().optional(),
      references: z.string().optional(),
      list_unsubscribe: z.string().optional(),
      attachments: z
        .array(
          z.object({
            name: z.string(),
            content: z.string(),
            content_type: z.string(),
            cid: z.string().optional(),
          })
        )
        .optional(),
      tags: z.union([z.string(), z.array(z.string())]).optional(),
    },
    async (params, _extra) => {
      try {
        if (!params.textbody && !params.htmlbody) {
          return {
            content: [
              {
                type: "text",
                text: "Either text or html content must be provided",
              },
            ],
            isError: true,
          };
        }

        // Send the email
        const result = await client.sendEmail(params);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "Email sent successfully",
                  data: { messageId: result.id, status: result.status },
                },
                null,
                2
              ),
            },
          ],
        };
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

// Domains API tools. These require an Organization API token.
if (organizationToken) {
  server.tool(
    "list-domains",
    "List the domains belonging to your MailPace organization.",
    {
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      sort: z.enum(["created_at", "id", "name"]).optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    },
    async ({ limit, offset, sort, direction }) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      if (sort !== undefined) params.set("sort", sort);
      if (direction !== undefined) params.set("direction", direction);

      const query = params.toString();
      return runOrganizationTool(() =>
        organizationRequest(`/domains${query ? `?${query}` : ""}`)
      );
    }
  );

  server.tool(
    "get-domain",
    "Get a single MailPace domain by ID.",
    {
      id: z.number().int().describe("The domain ID"),
    },
    async ({ id }) =>
      runOrganizationTool(() => organizationRequest(`/domains/${id}`))
  );

  server.tool(
    "create-domain",
    "Create a new sending domain in your MailPace organization.",
    {
      url: z
        .string()
        .describe("Lower-case domain with TLD, for example example.com"),
      name: z.string().optional().describe("Friendly name for your reference"),
    },
    async ({ url, name }) =>
      runOrganizationTool(() =>
        organizationRequest("/domains", {
          method: "POST",
          body: { domain: { url, ...(name !== undefined ? { name } : {}) } },
        })
      )
  );

  server.tool(
    "update-domain",
    "Update the name or URL of a MailPace domain.",
    {
      id: z.number().int().describe("The domain ID"),
      name: z.string().optional().describe("Friendly name for your reference"),
      url: z
        .string()
        .optional()
        .describe("Lower-case domain with TLD, for example example.com"),
    },
    async ({ id, name, url }) => {
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
        })
      );
    }
  );

  server.tool(
    "verify-domain",
    "Check the DKIM and advanced verification DNS records for a MailPace domain.",
    {
      id: z.number().int().describe("The domain ID"),
    },
    async ({ id }) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${id}/verify`, { method: "POST" })
      )
  );

  server.tool(
    "list-domain-api-tokens",
    "List the API tokens for a MailPace domain.",
    {
      domain_id: z.number().int().describe("The domain ID"),
    },
    async ({ domain_id }) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens`)
      )
  );

  server.tool(
    "get-domain-api-token",
    "Get a single API token for a MailPace domain.",
    {
      domain_id: z.number().int().describe("The domain ID"),
      id: z.number().int().describe("The API token ID"),
    },
    async ({ domain_id, id }) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`)
      )
  );

  server.tool(
    "create-domain-api-token",
    "Create a new API token for a MailPace domain.",
    {
      domain_id: z.number().int().describe("The domain ID"),
      name: z.string().optional().describe("Friendly token label"),
    },
    async ({ domain_id, name }) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens`, {
          method: "POST",
          body: { api_token: { ...(name !== undefined ? { name } : {}) } },
        })
      )
  );

  server.tool(
    "update-domain-api-token",
    "Update the name of an API token for a MailPace domain.",
    {
      domain_id: z.number().int().describe("The domain ID"),
      id: z.number().int().describe("The API token ID"),
      name: z.string().optional().describe("Friendly token label"),
    },
    async ({ domain_id, id, name }) => {
      if (name === undefined) {
        return errorResult("Provide a name to update the API token");
      }

      return runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`, {
          method: "PATCH",
          body: { api_token: { name } },
        })
      );
    }
  );

  server.tool(
    "revoke-domain-api-token",
    "Revoke an API token for a MailPace domain. This cannot be undone.",
    {
      domain_id: z.number().int().describe("The domain ID"),
      id: z.number().int().describe("The API token ID"),
    },
    async ({ domain_id, id }) =>
      runOrganizationTool(() =>
        organizationRequest(`/domains/${domain_id}/api_tokens/${id}`, {
          method: "DELETE",
        })
      )
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `MailPace MCP Server running on stdio (email sending: ${
      client ? "enabled" : "disabled"
    }, domain management: ${organizationToken ? "enabled" : "disabled"})`
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
