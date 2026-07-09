## Okta Calculator MCP Server

**Simple MCP server (Streamable HTTP) that exposes basic calculator tools and validates an Okta access token on tool calls.**

### Features

- **Calculator tools**: `add`, `subtract`, `multiply`, `divide`
- **Okta auth via Bearer token**: tool calls require an `Authorization: Bearer <okta-jwt>` header
- **Validation**: the server verifies the token as a JWT signed by Okta using the Okta JWKS endpoint
  (signature, issuer, audience, expiry)
- Discovery calls (`initialize`, `tools/list`) work without a token, so gateways can list tools

### Prerequisites

- Node.js 20+

### Configuration

Okta config is hardcoded in `src/server.ts`:

- **Issuer**: `https://truefoundry.okta.com` (Okta org authorization server)
- **Audience**: `https://truefoundry.okta.com`
- **JWKS**: `https://truefoundry.okta.com/oauth2/v1/keys`

The HTTP port defaults to `8080` and can be overridden with the `PORT` env var.

### Install, build and run

```bash
npm install
npm run build
npm start
```

For local development:

```bash
npm run dev
```

### Endpoints

- `POST /mcp` (and `POST /`): MCP Streamable HTTP endpoint
- `GET /health`: health probe, returns `{"status":"ok"}`

### MCP tools

Each tool takes `a` and `b` (numbers):

- **`add`**: returns `a + b`
- **`subtract`**: returns `a - b`
- **`multiply`**: returns `a * b`
- **`divide`**: returns `a / b` (errors on divide-by-zero)

Tool calls without a valid Okta Bearer token get HTTP 401:

> `Unauthorized: invalid or missing Okta token.`

### Docker

```bash
docker build -t okta-calculator-mcp .
docker run -p 8080:8080 okta-calculator-mcp
```

### TrueFoundry MCP Gateway

Register the deployed URL as a remote MCP server with **Token Passthrough** auth,
so the gateway forwards the caller's Okta Bearer token to this server on tool calls.
