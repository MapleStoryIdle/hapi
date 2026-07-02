/**
 * HAPI MCP server
 * Provides HAPI CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { detectImageMimeType, registerGeneratedImage } from "@/modules/common/generatedImages";

type StartHappyServerOptions = {
    emitTitleSummary?: boolean;
};

function createHapiMcpServer(client: ApiSessionClient, emitTitleSummary: boolean): McpServer {
    const handler = async (title: string) => {
        logger.debug('[hapiMCP] Changing title to:', title);
        try {
            if (emitTitleSummary) {
                client.sendClaudeSessionMessage({
                    type: 'summary',
                    summary: title,
                    leafUuid: randomUUID()
                });
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    const mcp = new McpServer({
        name: "HAPI MCP",
        version: "1.0.0",
    });

    const changeTitleInputSchema: z.ZodTypeAny = z.object({
        title: z.string().describe('The new title for the chat session'),
    });

    const displayImageInputSchema: z.ZodTypeAny = z.object({
        path: z.string().describe('Local filesystem path of the image to display to the user'),
        title: z.string().optional().describe('Optional display title or filename for the image'),
    });

    const verifySshServerCandidateInputSchema: z.ZodTypeAny = z.object({
        host: z.string().min(1).describe('SSH host or IP address'),
        user: z.string().min(1).describe('SSH username'),
        port: z.number().int().min(1).max(65535).optional().describe('SSH port, defaults to 22'),
        alias: z.string().max(120).optional().describe('SSH config Host alias if the successful command used one'),
        workspace: z.string().min(1).optional().describe('HAPI remote server workspace, defaults to 默认'),
        tags: z.array(z.string().min(1)).optional().describe('Optional server tags'),
        detectedCommandKind: z.enum(['ssh', 'scp', 'rsync']).describe('Command kind that discovered this server'),
        detectedToolCallId: z.string().optional().describe('Optional tool call id that discovered this server'),
    });

    mcp.registerTool<any, any>('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: changeTitleInputSchema,
    }, async (args: { title: string }) => {
        const response = await handler(args.title);
        logger.debug('[hapiMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        }

        return {
            content: [
                {
                    type: 'text' as const,
                    text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                },
            ],
            isError: true,
        };
    });

    mcp.registerTool<any, any>('display_image', {
        description: 'Display a local image file inline in the current HAPI chat session',
        title: 'Display Image',
        inputSchema: displayImageInputSchema,
    }, async (args: { path: string; title?: string }) => {
        logger.debug('[hapiMCP] Display image:', args.path);

        try {
            const info = await lstat(args.path);
            if (!info.isFile()) {
                throw new Error('Path is not a regular file');
            }

            const maxImageBytes = 25 * 1024 * 1024;
            if (info.size > maxImageBytes) {
                throw new Error('Image is too large to display inline');
            }

            const bytes = await readFile(args.path);
            const mimeType = detectImageMimeType(bytes);
            if (!mimeType) {
                throw new Error('Unsupported image content');
            }

            const image = registerGeneratedImage({
                id: randomUUID(),
                path: args.path,
                fileName: args.title,
                mimeType,
                bytes
            });

            client.sendAgentMessage({
                type: 'generated-image',
                imageId: image.id,
                fileName: image.fileName,
                mimeType: image.mimeType,
                id: randomUUID()
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Displayed image: ${image.fileName}`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to display image:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to display image: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool<any, any>('verify_ssh_server_candidate', {
        description: 'Verify an SSH server is reachable and create a pending HAPI remote server candidate for user confirmation. Use this only after a successful ssh, scp, or rsync command.',
        title: 'Verify SSH Server Candidate',
        inputSchema: verifySshServerCandidateInputSchema,
    }, async (args: {
        host: string;
        user: string;
        port?: number;
        alias?: string;
        workspace?: string;
        tags?: string[];
        detectedCommandKind: 'ssh' | 'scp' | 'rsync';
        detectedToolCallId?: string;
    }) => {
        try {
            await verifySshConnection(args.user, args.host, args.port ?? 22);
            const response = await client.verifyRemoteServerCandidate({
                host: args.host,
                user: args.user,
                port: args.port,
                alias: args.alias,
                workspace: args.workspace,
                tags: args.tags,
                detectedCommandKind: args.detectedCommandKind,
                detectedToolCallId: args.detectedToolCallId ?? null
            });
            if (response.status === 'already-recorded') {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `SSH server already recorded: ${response.server.user}@${response.server.host}:${response.server.port} (${response.server.workspace})`,
                        },
                    ],
                    isError: false,
                };
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Verified SSH server candidate: ${response.candidate.user}@${response.candidate.host}:${response.candidate.port}. Waiting for user confirmation in HAPI.`,
                    },
                ],
                isError: false,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.debug('[hapiMCP] Failed to verify SSH server candidate:', message);
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: `Failed to verify SSH server candidate: ${message}`,
                    },
                ],
                isError: true,
            };
        }
    });

    return mcp;
}

async function verifySshConnection(user: string, host: string, port: number): Promise<void> {
    const proc = Bun.spawn([
        'ssh',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=yes',
        '-p', String(port),
        `${user}@${host}`,
        'true'
    ], {
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
        return;
    }

    const stderr = await new Response(proc.stderr).text().catch(() => '');
    const reason = stderr.trim().split('\n').slice(-1)[0] || `ssh exited with ${exitCode}`;
    throw new Error(reason);
}

function readMcpSessionId(req: IncomingMessage): string | undefined {
    const raw = req.headers['mcp-session-id'];
    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw)) {
        return raw[0];
    }
    return undefined;
}

export async function startHappyServer(client: ApiSessionClient, options: StartHappyServerOptions = {}) {
    const emitTitleSummary = options.emitTitleSummary ?? true;
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const mcps = new Map<string, McpServer>();

    const createMcpTransport = () => {
        const mcp = createHapiMcpServer(client, emitTitleSummary);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                transports.set(sessionId, transport);
                mcps.set(sessionId, mcp);
            },
            onsessionclosed: (sessionId) => {
                transports.delete(sessionId);
                const server = mcps.get(sessionId);
                mcps.delete(sessionId);
                void server?.close();
            },
        });
        void mcp.connect(transport);
        return transport;
    };

    const server = createServer(async (req, res) => {
        try {
            const sessionId = readMcpSessionId(req);
            const transport = sessionId
                ? transports.get(sessionId)
                : createMcpTransport();

            if (!transport) {
                if (!res.headersSent) {
                    res.writeHead(404).end();
                }
                return;
            }

            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    const mcpUrl = baseUrl.toString();
    client.updateMetadata((metadata) => ({
        ...metadata,
        hapiMcpUrl: mcpUrl,
    }));

    return {
        url: mcpUrl,
        toolNames: ['change_title', 'display_image', 'verify_ssh_server_candidate'],
        stop: () => {
            logger.debug('[hapiMCP] Stopping server');
            for (const mcp of mcps.values()) {
                mcp.close();
            }
            transports.clear();
            mcps.clear();
            server.close();
        }
    };
}
