import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.log("[okta-calculator-mcp] Server started (stdio transport).");
  })
  .catch((err) => {
    console.error("[okta-calculator-mcp] Failed to start server:", err);
    process.exitCode = 1;
  });

