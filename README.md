# MailPace MCP (Model Context Protocol) Server

[![smithery badge](https://smithery.ai/badge/@mailpace/mailpace-mcp)](https://smithery.ai/server/@mailpace/mailpace-mcp)

MailPace MCP (Model Context Protocol) Server is an MCP server implementation that allows sending emails over MailPace's fast transactional email API.

## Features

- Send email over the [MailPace](https://mailpace.com) Transactional Email API

## Tool

### send-email

Sends an email to one or more recipients.

**Inputs**
- Email with fields shown in MailPace documentation: https://docs.mailpace.com/reference/send/

## Usage

### Installing via Smithery

To install MailPace MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@mailpace/mailpace-mcp):

```bash
npx -y @smithery/cli install @mailpace/mailpace-mcp --client claude
```

### Domain and Token

- Create an organization and domain at https://app.mailpace.com
- Copy your domain API token
- Start the MCP with the `MAILPACE_API_TOKEN` env set, or pass it to the server with the `--token` argument

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
