# MailPace MCP (Model Context Protocol) Server

[![smithery badge](https://smithery.ai/badge/@mailpace/mailpace-mcp)](https://smithery.ai/server/@mailpace/mailpace-mcp)

MailPace MCP (Model Context Protocol) Server is an MCP server implementation that allows sending emails and managing domains over MailPace's fast transactional email API.

## Features

- Send email over the [MailPace](https://mailpace.com) Transactional Email API
- List, create, update, and verify domains with the [MailPace Domains API](https://docs.mailpace.com/reference/domains)
- Manage domain API tokens

## Tools

### send-email

Sends an email to one or more recipients.

**Inputs**
- Email with fields shown in MailPace documentation: https://docs.mailpace.com/reference/send/

Requires a **domain API token**.

### Domain management

The following tools require an **organization API token**:

| Tool | Description |
| --- | --- |
| `list-domains` | List domains, with optional pagination and sorting |
| `get-domain` | Get a domain by ID |
| `create-domain` | Create a domain |
| `update-domain` | Update a domain's name or URL |
| `verify-domain` | Check DKIM and advanced verification DNS records |
| `list-domain-api-tokens` | List API tokens for a domain |
| `get-domain-api-token` | Get one API token for a domain |
| `create-domain-api-token` | Create an API token for a domain |
| `update-domain-api-token` | Update an API token's name |
| `revoke-domain-api-token` | Revoke an API token for a domain |

See the [Domains API documentation](https://docs.mailpace.com/reference/domains) for request and response details.

## Usage

### Installing via Smithery

To install MailPace MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@mailpace/mailpace-mcp):

```bash
npx -y @smithery/cli install @mailpace/mailpace-mcp --client claude
```

### Domain and Token setup

- Create an organization and domain at https://app.mailpace.com
- To send email, copy your **domain API token** and set `MAILPACE_API_TOKEN` (or pass `--token`)
- To manage domains, create an **organization API token** from your Organization's API Tokens page and set `MAILPACE_ORGANIZATION_TOKEN` (or pass `--organization-token`)

At least one token is required. Only the tools supported by the provided token(s) will be registered.

## Build and run

`npm run build`
`npm run start`

## Contributing

We welcome contributions to the MailPace MCP Server. To contribute, please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Commit your changes and push the branch to your fork.
4. Create a pull request with a detailed description of your changes.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more details.

## Contact

For any questions or support, please contact us at support@mailpace.com
