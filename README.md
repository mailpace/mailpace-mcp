# MailPace MCP (Model Context Protocol) Server

MailPace MCP Server exposes the [MailPace](https://mailpace.com) transactional email, domain management, and email status APIs to MCP clients.

## Features

- Send transactional email with the [Send API](https://docs.mailpace.com/reference/send)
- List, create, update, and verify domains with the [Domains API](https://docs.mailpace.com/reference/domains)
- Manage domain API tokens
- Check delivery, bounce, and deferral status with the [Email Status API](https://docs.mailpace.com/reference/email-status)
- Optional recipient allowlist and idempotent sends
- Tools expose structured output schemas and MCP behavior annotations

## Requirements

- Node.js 20 or newer
- A MailPace organization and domain
- A **domain API token** to send email and check email status for that domain
- An **organization API token** to manage domains and domain API tokens

## Configuration

Credentials are read from environment variables only. They are never accepted as command-line arguments, which would expose them in process listings.

| Variable | Required | Description |
| --- | --- | --- |
| `MAILPACE_API_TOKEN` | For sending and domain-scoped status | Domain API token |
| `MAILPACE_ORGANIZATION_TOKEN` | For domain management | Organization API token |
| `MAILPACE_ALLOWED_RECIPIENTS` | No | Comma-separated allowlist of exact addresses or `@domain` rules. When set, `mailpace_send_email` refuses other recipients. |
| `MAILPACE_API_URL` | No | Override the API base URL. Must be HTTPS except for localhost development. |
| `MAILPACE_REQUEST_TIMEOUT_MS` | No | Per-request timeout in milliseconds. Default `30000`. |
| `MAILPACE_MAX_RETRIES` | No | Retries for idempotent requests and 429 responses. Default `2`. |

At least one of `MAILPACE_API_TOKEN` or `MAILPACE_ORGANIZATION_TOKEN` is required. Tools are registered according to the available credentials.

## Tools

| Tool | Credential | Description |
| --- | --- | --- |
| `mailpace_send_email` | Domain token | Send an email. Supports attachments, tags, and `Idempotency-Key`. |
| `mailpace_get_email_status` | Domain or organization token | Get delivery, bounce, or deferral status by domain and email ID. |
| `mailpace_list_domains` | Organization token | List domains with pagination and sorting. |
| `mailpace_get_domain` | Organization token | Get a domain by ID. |
| `mailpace_create_domain` | Organization token | Create a sending domain. |
| `mailpace_update_domain` | Organization token | Update a domain's name or URL. |
| `mailpace_verify_domain` | Organization token | Check DKIM and advanced verification DNS records. |
| `mailpace_list_domain_api_tokens` | Organization token | List a domain's API tokens. |
| `mailpace_get_domain_api_token` | Organization token | Get one domain API token. |
| `mailpace_create_domain_api_token` | Organization token | Create a domain API token. Store the returned token securely. |
| `mailpace_update_domain_api_token` | Organization token | Rename a domain API token. |
| `mailpace_revoke_domain_api_token` | Organization token | Revoke a domain API token. This cannot be undone. |

### Sending email safely

`mailpace_send_email` is an external side effect. Clients and hosts should confirm recipients before invoking it. For automation, set `MAILPACE_ALLOWED_RECIPIENTS` to reduce the impact of mistakes or prompt injection, for example:

```bash
MAILPACE_ALLOWED_RECIPIENTS="hello@example.com,@yourcompany.com"
```

Use an `idempotency_key` when retrying a send to prevent duplicate email delivery.

## Client configuration

After building locally, point your MCP client at the built entry point:

```json
{
  "mcpServers": {
    "mailpace": {
      "command": "node",
      "args": ["/absolute/path/to/mailpace-mcp/build/index.js"],
      "env": {
        "MAILPACE_API_TOKEN": "your-domain-api-token",
        "MAILPACE_ORGANIZATION_TOKEN": "your-organization-api-token"
      }
    }
  }
}
```

Once published, this can also be run with `npx -y mailpace-mcp`.

## Build and run

```bash
npm ci
npm run build
npm start
```

Development uses `tsx` and TypeScript source directly:

```bash
npm run dev
```

## Testing

```bash
npm test
```

The integration tests start the built server, connect over stdio, and exercise tool registration, request shapes, validation, error mapping, retries, and timeouts against a local mock MailPace API.

## Docker

```bash
docker build -t mailpace-mcp .
docker run --rm -i \
  -e MAILPACE_API_TOKEN=your-domain-api-token \
  -e MAILPACE_ORGANIZATION_TOKEN=your-organization-api-token \
  mailpace-mcp
```

The image runs as the non-root `node` user and installs only production dependencies.

## Security

- Tokens are read from the environment only.
- Use a domain token for sending and an organization token only when domain management is needed.
- Keep `MAILPACE_ALLOWED_RECIPIENTS` set in unattended deployments.
- Revoke unused domain API tokens from the MailPace dashboard.

## Contributing

1. Fork the repository.
2. Create a new branch for your feature or bugfix.
3. Commit your changes and push the branch to your fork.
4. Create a pull request with a detailed description of your changes.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE.md) file for details.

## Contact

For any questions or support, please contact us at support@mailpace.com.
