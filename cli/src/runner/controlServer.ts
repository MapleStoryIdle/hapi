/**
 * HTTP control server for runner management
 * Provides endpoints for listing sessions, stopping sessions, and runner shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { ExternalCodexRequestPayloadSchema, type ExternalCodexRequestPayload } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';
import type { ExternalCodexLifecycleEvent } from '@/codex/nativeTurnLifecycle';

const externalCodexRequestSchema = ExternalCodexRequestPayloadSchema.omit({ machineId: true });
const externalCodexLifecycleSchema = z.object({
  codexSessionId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  event: z.literal('turn_started'),
  observedAt: z.number().int().nonnegative()
}).strict();

export function startRunnerControlServer({
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  onCodexRecoveryReady,
  onCodexRecoveryUnconfirmed,
  onExternalCodexRequest,
  onExternalCodexLifecycle
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean | Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => Promise<void> | void;
  onCodexRecoveryReady?: (input: { recoveryRequestId: string; sessionId: string; threadId: string }) => boolean;
  onCodexRecoveryUnconfirmed?: (input: { recoveryRequestId: string; sessionId: string; threadId: string; error: string }) => boolean;
  onExternalCodexRequest: (request: Omit<ExternalCodexRequestPayload, 'machineId'>) => void;
  onExternalCodexLifecycle: (event: ExternalCodexLifecycleEvent) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any() // Metadata type from API
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      await onHappySessionWebhook(sessionId, metadata);

      return { status: 'ok' as const };
    });

    typed.post('/codex-recovery-ready', {
      schema: {
        body: z.object({ recoveryRequestId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), threadId: z.string().min(1).max(200) }).strict(),
        response: { 200: z.object({ status: z.literal('ok') }), 409: z.object({ status: z.literal('rejected') }) }
      }
    }, async (request, reply) => {
      if (onCodexRecoveryReady?.(request.body) !== true) {
        reply.code(409)
        return { status: 'rejected' as const }
      }
      return { status: 'ok' as const }
    })

    typed.post('/codex-recovery-unconfirmed', {
      schema: {
        body: z.object({ recoveryRequestId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), threadId: z.string().min(1).max(200), error: z.string().min(1).max(2_000) }).strict(),
        response: { 200: z.object({ status: z.literal('ok') }), 409: z.object({ status: z.literal('rejected') }) }
      }
    }, async (request, reply) => {
      if (onCodexRecoveryUnconfirmed?.(request.body) !== true) {
        reply.code(409)
        return { status: 'rejected' as const }
      }
      return { status: 'ok' as const }
    })

    // Global Codex hooks forward native permission prompts and
    // request_user_input calls here. The hook payload has already been
    // reduced to non-sensitive routing metadata by the forwarder.
    typed.post('/codex-external-request', {
      schema: {
        body: externalCodexRequestSchema,
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      onExternalCodexRequest(request.body);
      return { status: 'ok' as const };
    });

    // UserPromptSubmit is a lifecycle signal only. It deliberately has no
    // relation to permission/request notifications and accepts no raw hook
    // payload fields.
    typed.post('/codex-external-lifecycle', {
      schema: {
        body: externalCodexLifecycleSchema,
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      onExternalCodexLifecycle(request.body);
      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = await stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          sessionType: z.enum(['simple', 'worktree']).optional(),
          worktreeName: z.string().optional()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, sessionType, worktreeName } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const result = await spawnSession({ directory, sessionId, sessionType, worktreeName });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop runner
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop runner request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering runner shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
