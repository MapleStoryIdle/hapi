import type { Database } from 'bun:sqlite'

import type {
    StoredRemoteServer,
    StoredRemoteServerCandidate,
    StoredRemoteServerCandidateStatus
} from './types'
import {
    acceptRemoteServerCandidate,
    deleteRemoteServer,
    dismissRemoteServerCandidate,
    findRemoteServerByTarget,
    getRemoteServerByNamespace,
    getRemoteServerCandidateByNamespace,
    listRemoteServerCandidates,
    listRemoteServers,
    remoteServerHasConnection,
    touchRemoteServerLastUsed,
    updateRemoteServer,
    verifyRemoteServerCandidate,
    type AcceptRemoteServerCandidateInput,
    type AcceptRemoteServerCandidateResult,
    type RemoteServerCandidateInput,
    type UpdateRemoteServerInput,
    type VerifyRemoteServerCandidateResult
} from './remoteServers'

export class RemoteServerStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    listRemoteServers(namespace: string): StoredRemoteServer[] {
        return listRemoteServers(this.db, namespace)
    }

    getRemoteServerByNamespace(id: string, namespace: string): StoredRemoteServer | null {
        return getRemoteServerByNamespace(this.db, id, namespace)
    }

    findRemoteServerByTarget(
        namespace: string,
        workspace: string,
        user: string,
        host: string,
        port: number
    ): StoredRemoteServer | null {
        return findRemoteServerByTarget(this.db, namespace, workspace, user, host, port)
    }

    touchRemoteServerLastUsed(id: string, namespace: string, at: number, machineId?: string | null): StoredRemoteServer | null {
        return touchRemoteServerLastUsed(this.db, id, namespace, at, machineId)
    }

    hasConnection(id: string, machineId?: string | null): boolean {
        return remoteServerHasConnection(this.db, id, machineId)
    }

    updateRemoteServer(id: string, namespace: string, input: UpdateRemoteServerInput): StoredRemoteServer | null {
        return updateRemoteServer(this.db, id, namespace, input)
    }

    deleteRemoteServer(id: string, namespace: string): boolean {
        return deleteRemoteServer(this.db, id, namespace)
    }

    verifyRemoteServerCandidate(input: RemoteServerCandidateInput): VerifyRemoteServerCandidateResult {
        return verifyRemoteServerCandidate(this.db, input)
    }

    listRemoteServerCandidates(
        namespace: string,
        status?: StoredRemoteServerCandidateStatus
    ): StoredRemoteServerCandidate[] {
        return listRemoteServerCandidates(this.db, namespace, status)
    }

    getRemoteServerCandidateByNamespace(id: string, namespace: string): StoredRemoteServerCandidate | null {
        return getRemoteServerCandidateByNamespace(this.db, id, namespace)
    }

    acceptRemoteServerCandidate(
        id: string,
        namespace: string,
        input: AcceptRemoteServerCandidateInput
    ): AcceptRemoteServerCandidateResult {
        return acceptRemoteServerCandidate(this.db, id, namespace, input)
    }

    dismissRemoteServerCandidate(id: string, namespace: string): StoredRemoteServerCandidate | null {
        return dismissRemoteServerCandidate(this.db, id, namespace)
    }
}
