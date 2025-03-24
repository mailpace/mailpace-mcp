import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import MailPace from "@mailpace/mailpace.js";
import minimist from "minimist";

const argv = minimist(process.argv.slice(2));
const token = argv.token || process.env.MAILPACE_API_TOKEN;

if (!token) {
  console.error(
    "No API key provided. Please set MAILPACE_API_TOKEN environment variable or use --token argument"
  );
  process.exit(1);
}

const client = new MailPace.DomainClient(token);

const server = new McpServer({
  name: "transactional-email-sending-service",
  version: "1.0.0",
});

// Define the email tool
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
        attachments: z.array(z.object({
            name: z.string(),
            content: z.string(),
            content_type: z.string(),
            cid: z.string().optional()
        })).optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional()
    },
    async (params, _extra) => {
        try {
            if (!params.textbody && !params.htmlbody) {
                return {
                    content: [{ type: "text", text: "Either text or html content must be provided" }],
                    isError: true
                };
            }

            // Send the email
            const result = await client.sendEmail(params);

            return {
                content: [
                    { 
                        type: "text", 
                        text: JSON.stringify({
                            success: true,
                            message: "Email sent successfully",
                            data: { messageId: result.id, status: result.status }
                        }, null, 2)
                    }
                ]
            };

        } catch (error: any) {
            console.error(`Error sending email: ${error.message}`);
            
            return {
                content: [
                    { 
                        type: "text", 
                        text: JSON.stringify({
                            success: false,
                            message: "Failed to send email",
                            error: error.message
                        }, null, 2)
                    }
                ],
                isError: true
            };
        }
    }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Email sending service MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
