import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

// Hard-coded Okta config for this MCP
const OKTA_ISSUER = "https://truefoundry.okta.com";
// Okta org authorization server issues access tokens with aud = org URL
const OKTA_AUDIENCE = "https://truefoundry.okta.com";

// JWK set for Okta Org Authorization Server
const jwks = createRemoteJWKSet(
  new URL(`${OKTA_ISSUER}/oauth2/v1/keys`)
);

async function validateOktaToken(token: string): Promise<boolean> {
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: OKTA_ISSUER,
      audience: OKTA_AUDIENCE
    });

    const payload: JWTPayload = result.payload;

    // Basic sanity checks – make sure the token is not expired, etc.
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn("[okta-calculator-mcp] Okta token is expired.");
      return false;
    }

    return true;
  } catch (err) {
    console.error("[okta-calculator-mcp] Okta token validation failed:", err);
    return false;
  }
}

type CalculatorInput = {
  a: number;
  b: number;
  oktaToken: string;
};

const calculatorInputSchema = {
  a: z.number(),
  b: z.number(),
  oktaToken: z
    .string()
    .describe("Okta access token (raw JWT from Okta).")
};

type CalculatorResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function withOktaAuth(
  handler: (input: CalculatorInput) => Promise<CalculatorResult>
): (input: CalculatorInput) => Promise<CalculatorResult> {
  return async (input) => {
    const valid = await validateOktaToken(input.oktaToken);

    if (!valid) {
      return {
        content: [
          {
            type: "text",
            text: "Invalid or expired Okta token."
          }
        ],
        isError: true
      };
    }

    return handler(input);
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "okta-calculator-mcp",
    version: "0.1.0"
  });

  server.tool(
    "add",
    calculatorInputSchema,
    withOktaAuth(async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }]
    }))
  );

  server.tool(
    "subtract",
    calculatorInputSchema,
    withOktaAuth(async ({ a, b }) => ({
      content: [{ type: "text", text: String(a - b) }]
    }))
  );

  server.tool(
    "multiply",
    calculatorInputSchema,
    withOktaAuth(async ({ a, b }) => ({
      content: [{ type: "text", text: String(a * b) }]
    }))
  );

  server.tool(
    "divide",
    calculatorInputSchema,
    withOktaAuth(async ({ a, b }) => {
      if (b === 0) {
        return {
          content: [
            { type: "text", text: "Error: Cannot divide by zero" }
          ],
          isError: true
        };
      }

      return {
        content: [{ type: "text", text: String(a / b) }]
      };
    })
  );

  return server;
}

// Stateless Streamable HTTP transport: every request is handled independently,
// which keeps the service horizontally scalable behind a load balancer.
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
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
});

// Stateless server: session-based GET/DELETE are not supported
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null
  });
});

const PORT = Number(process.env.PORT ?? 8080);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[okta-calculator-mcp] Server listening on http://0.0.0.0:${PORT}/mcp`
  );
});

