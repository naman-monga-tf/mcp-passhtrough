import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

// Hard-coded Okta config for this MCP
const OKTA_ISSUER = "https://truefoundry.okta.com";
// Okta org authorization server issues access tokens with aud = org URL
const OKTA_AUDIENCE = "https://truefoundry.okta.com";

// TrueFoundry platform tokens (live-demo tenant) are also accepted, since the
// MCP Gateway's Token Passthrough forwards whichever token the caller used
// for inbound auth: an IdP (Okta) JWT or a TrueFoundry token.
const TFY_ISSUER = "truefoundry.com";
const TFY_JWKS_URL = "https://login.truefoundry.com/.well-known/jwks.json";
const TFY_ALLOWED_TENANT = "live-demo";

// JWK set for Okta Org Authorization Server
const oktaJwks = createRemoteJWKSet(new URL(`${OKTA_ISSUER}/oauth2/v1/keys`));
const tfyJwks = createRemoteJWKSet(new URL(TFY_JWKS_URL));

async function validateOktaToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, oktaJwks, {
      issuer: OKTA_ISSUER,
      audience: OKTA_AUDIENCE
    });
    return true;
  } catch (err) {
    console.warn(`[okta-calculator-mcp] Not a valid Okta token: ${err}`);
    return false;
  }
}

async function validatePlatformToken(token: string): Promise<boolean> {
  try {
    const { payload }: { payload: JWTPayload & { tenantName?: string } } =
      await jwtVerify(token, tfyJwks, { issuer: TFY_ISSUER });

    if (payload.tenantName !== TFY_ALLOWED_TENANT) {
      console.warn(
        `[okta-calculator-mcp] Platform token tenant '${payload.tenantName}' not allowed; expected '${TFY_ALLOWED_TENANT}'.`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[okta-calculator-mcp] Not a valid platform token: ${err}`);
    return false;
  }
}

async function validateToken(token: string): Promise<boolean> {
  return (
    (await validateOktaToken(token)) || (await validatePlatformToken(token))
  );
}

const calculatorInputSchema = {
  a: z.number(),
  b: z.number()
};

function createServer(): McpServer {
  const server = new McpServer({
    name: "okta-calculator-mcp",
    version: "0.1.0"
  });

  server.tool("add", calculatorInputSchema, async ({ a, b }) => ({
    content: [{ type: "text" as const, text: String(a + b) }]
  }));

  server.tool("subtract", calculatorInputSchema, async ({ a, b }) => ({
    content: [{ type: "text" as const, text: String(a - b) }]
  }));

  server.tool("multiply", calculatorInputSchema, async ({ a, b }) => ({
    content: [{ type: "text" as const, text: String(a * b) }]
  }));

  server.tool("divide", calculatorInputSchema, async ({ a, b }) => {
    if (b === 0) {
      return {
        content: [
          { type: "text" as const, text: "Error: Cannot divide by zero" }
        ],
        isError: true
      };
    }

    return {
      content: [{ type: "text" as const, text: String(a / b) }]
    };
  });

  return server;
}

// Stateless Streamable HTTP transport: every request is handled independently,
// which keeps the service horizontally scalable behind a load balancer.
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function isToolCall(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as { method?: string }).method === "tools/call"
  );
}

async function handleMcpRequest(
  req: express.Request,
  res: express.Response
): Promise<void> {
  // Some MCP clients/gateways (e.g. TrueFoundry MCP Gateway) don't send
  // "Accept: application/json, text/event-stream", which the SDK transport
  // requires. Normalize the header so those requests aren't rejected.
  // The SDK builds the web Request from req.rawHeaders (via Hono), so the
  // raw header list must be rewritten, not just req.headers.
  const accept = req.headers.accept ?? "";
  if (
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    const normalized = "application/json, text/event-stream";
    req.headers.accept = normalized;
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i].toLowerCase() === "accept") {
        req.rawHeaders.splice(i, 2);
      }
    }
    req.rawHeaders.push("Accept", normalized);
  }

  // Tool calls must carry a valid Bearer token: either an Okta JWT or a
  // TrueFoundry platform token (live-demo tenant). The MCP Gateway's Token
  // Passthrough forwards the caller's inbound Authorization header as-is.
  // Discovery calls (initialize, tools/list) are allowed without a token.
  if (isToolCall(req.body)) {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";

    if (!token || !(await validateToken(token))) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Unauthorized: token is not a valid Okta JWT or TrueFoundry (live-demo) token."
        },
        id: null
      });
      return;
    }
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[okta-calculator-mcp] Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
}

// Serve MCP at both /mcp and / so the gateway works regardless of
// whether the registered URL includes the /mcp path.
app.post("/mcp", handleMcpRequest);
app.post("/", handleMcpRequest);

// Stateless server: session-based GET/DELETE are not supported
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null
  });
};
app.get("/mcp", methodNotAllowed);
app.get("/", methodNotAllowed);

const PORT = Number(process.env.PORT ?? 8080);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[okta-calculator-mcp] Server listening on http://0.0.0.0:${PORT}/mcp`
  );
});

