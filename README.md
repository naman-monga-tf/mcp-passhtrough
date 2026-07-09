## Okta Calculator MCP Server

**Simple MCP server that exposes basic calculator tools and validates an Okta access token on every call.**

### Features

- **Calculator tools**: `add`, `subtract`, `multiply`, `divide`
- **Okta token acceptance**: each tool requires an `oktaToken` argument
- **Validation**: the server verifies the token as a JWT signed by Okta using the Okta JWKS endpoint
  - Checks issuer and (optionally) audience
  - Verifies signature and expiry

### Prerequisites

- Node.js 20+

### Configuration

Everything is hardcoded in `src/server.ts`:

- **Issuer**: `https://truefoundry.okta.com` (Okta org authorization server)
- **Audience**: `https://truefoundry.okta.com`
- **JWKS**: `https://truefoundry.okta.com/oauth2/v1/keys`

To change any of these, edit the constants at the top of `src/server.ts` and rebuild.

### Install

```bash
cd /Users/naman/Code/local/cdk-demo/mcp-passhtrough
npm install
```

### Build and run

```bash
# Build TypeScript to JavaScript
npm run build

# Run the MCP server over stdio
npm start
```

For local testing during development, you can also run it directly with `tsx`:

```bash
npm run dev
```

### MCP tools

Each tool takes the same arguments:

- **`a`**: number
- **`b`**: number
- **`oktaToken`**: string – the Okta access token (raw JWT)

Tools:

- **`add`**: returns `a + b`
- **`subtract`**: returns `a - b`
- **`multiply`**: returns `a * b`
- **`divide`**: returns `a / b` (errors on divide-by-zero)

If the Okta token is invalid, expired, or fails signature/issuer/audience checks, the tool returns an error response with the message:

> `Invalid or expired Okta token.`

### Wiring into an MCP client

In your MCP-capable client (e.g. Cursor, Claude Desktop, MCP Inspector), configure this server as a stdio MCP with a command like:

```json
{
  "mcpServers": {
    "okta-calculator-mcp": {
      "command": "node",
      "args": [
        "dist/server.js"
      ]
    }
  }
}
```

Once configured, you should see the `add`, `subtract`, `multiply`, and `divide` tools, each requiring an `oktaToken` parameter, and they will only execute when the provided token is a valid Okta JWT.

