/**
 * Runner-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';
import type { ProcessIdentity } from '@/utils/process';

/**
 * Session tracking for runner
 */
export interface TrackedSession {
  startedBy: 'runner' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  launchId?: string;
  processIdentity?: ProcessIdentity;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
}
