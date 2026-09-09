import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** Keep this file alongside database backups, but separate from the database. */
export class MonitorTokenCipher {
    private key?: Buffer
    constructor(private readonly dbPath: string) {}

    private loadKey(allowCreate: boolean): Buffer {
        if (this.key) return this.key
        if (this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:')) return this.key = randomBytes(32)
        const path = `${this.dbPath}.monitor-key`
        let key: Buffer
        try { key = readFileSync(path) } catch (error) {
            if (!allowCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Monitor token key unavailable')
            try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
            }
            key = readFileSync(path)
        }
        if (key.length !== 32) throw new Error('Invalid monitor token key')
        return this.key = key
    }

    encrypt(token: string, context: string, allowCreate: boolean): string {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', this.loadKey(allowCreate), iv)
        cipher.setAAD(Buffer.from(context))
        const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
    }

    decrypt(value: string, context: string): string {
        const data = Buffer.from(value, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', this.loadKey(false), data.subarray(0, 12))
        decipher.setAAD(Buffer.from(context))
        decipher.setAuthTag(data.subarray(12, 28))
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    }
}
