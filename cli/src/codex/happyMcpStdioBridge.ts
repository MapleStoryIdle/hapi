/**
 * HAPI MCP STDIO Bridge
 *
 * STDIO MCP server exposing the HAPI tool capability set, including A2A peer tools.
 * On invocation it forwards the tool call to an existing HAPI HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPI_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import {
  INSPECT_PEER_TOOL_DESCRIPTION,
  PING_PEER_TOOL_DESCRIPTION,
  SESSION_ID_PREFIX_PARAM_DESCRIPTION,
} from '@hapi/protocol/sessionCitation';

/** stdio bridge 可代理的 HTTP MCP 工具；供外部宿主做能力发现。 */
export const HAPI_MCP_STDIO_TOOL_NAMES = [
  'change_title',
  'display_image',
  'list_peers',
  'inspect_peer',
  'ping_peer',
] as const;

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

export async function runHappyMcpStdioBridge(argv: string[]): Promise<void> {
  try {
    // Resolve target HTTP MCP URL
    const { url: urlFromArgs } = parseArgs(argv);
    const baseUrl = urlFromArgs || process.env.HAPI_HTTP_MCP_URL || '';

    if (!baseUrl) {
      // Write to stderr; never stdout.
      process.stderr.write(
        '[hapi-mcp] Missing target URL. Set HAPI_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
      );
      process.exit(2);
    }

    let httpClient: Client | null = null;

    async function ensureHttpClient(): Promise<Client> {
      if (httpClient) return httpClient;
      const client = new Client(
        { name: 'hapi-stdio-bridge', version: '1.0.0' },
        { capabilities: {} }
      );

      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      await client.connect(transport);
      httpClient = client;
      return client;
    }

    async function forwardTool(name: string, args: Record<string, unknown>, failureLabel: string): Promise<any> {
      try {
        const client = await ensureHttpClient();
        return await client.callTool({ name, arguments: args }) as any;
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `${failureLabel}: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
    }

    // Create STDIO MCP server
    const server = new McpServer({
      name: 'HAPI MCP Bridge',
      version: '1.0.0',
    });

    // Register tools and forward to HTTP MCP
    const changeTitleInputSchema: z.ZodTypeAny = z.object({
      title: z.string().describe('The new title for the chat session'),
    });

    server.registerTool<any, any>(
      'change_title',
      {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: changeTitleInputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const client = await ensureHttpClient();
          const response = await client.callTool({ name: 'change_title', arguments: args });
          // Pass-through response from HTTP server
          return response as any;
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      }
    );



    const displayImageInputSchema: z.ZodTypeAny = z.object({
      path: z.string().describe('Local filesystem path of the image to display to the user'),
      title: z.string().optional().describe('Optional display title or filename for the image'),
    });

    server.registerTool<any, any>(
      'display_image',
      {
        description: 'Display a local image file inline in the current HAPI chat session',
        title: 'Display Image',
        inputSchema: displayImageInputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const client = await ensureHttpClient();
          const response = await client.callTool({ name: 'display_image', arguments: args });
          return response as any;
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Failed to display image: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      }
    );


    const listPeersInputSchema: z.ZodTypeAny = z.object({
      limit: z.number().int().min(1).max(100).optional().describe('Max sessions to return (default 30, max 100).'),
    });

    server.registerTool<any, any>(
      'list_peers',
      {
        description: 'List peer HAPI sessions on the same hub/namespace. Then use inspect_peer or ping_peer with a listed id.',
        title: 'List Peer Sessions',
        inputSchema: listPeersInputSchema,
      },
      async (args: Record<string, unknown>) => await forwardTool('list_peers', args, 'Failed to list peers')
    );

    const inspectPeerInputSchema: z.ZodTypeAny = z.object({
      sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
      messageLimit: z.number().int().min(1).max(100).optional().describe('Recent message page size (default 30, max 100).'),
    });

    server.registerTool<any, any>(
      'inspect_peer',
      {
        description: INSPECT_PEER_TOOL_DESCRIPTION,
        title: 'Inspect Peer Session',
        inputSchema: inspectPeerInputSchema,
      },
      async (args: Record<string, unknown>) => await forwardTool('inspect_peer', args, 'Failed to inspect peer')
    );

    const pingPeerInputSchema: z.ZodTypeAny = z.object({
      sessionIdPrefix: z.string().trim().min(1).describe(SESSION_ID_PREFIX_PARAM_DESCRIPTION),
      message: z.string().min(1).describe('Message text to deliver to the target session'),
    });

    server.registerTool<any, any>(
      'ping_peer',
      {
        description: PING_PEER_TOOL_DESCRIPTION,
        title: 'Ping Peer Session',
        inputSchema: pingPeerInputSchema,
      },
      async (args: Record<string, unknown>) => await forwardTool('ping_peer', args, 'Failed to ping peer')
    );

    // Start STDIO transport
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
  } catch (err) {
    try {
      process.stderr.write(`[hapi-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.exit(1);
    }
  }
}
