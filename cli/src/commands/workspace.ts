import { randomBytes } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import chalk from 'chalk'
import { registerWorkspace } from '@/authV2/client'
import { resolveAuthV2HubUrl } from '@/authV2/hubUrl'
import type { CommandDefinition } from './types'

interface WorkspaceRegisterArgs {
    name?: string
    hubUrl?: string
    registrationSecret?: string
    outputTokenFile?: string
}

function parseWorkspaceRegisterArgs(args: string[]): WorkspaceRegisterArgs | null {
    if (args[0] !== 'register') return null

    const parsed: WorkspaceRegisterArgs = {}
    for (let index = 1; index < args.length;) {
        const flag = args[index]
        if (!flag?.startsWith('--') && !parsed.name) {
            parsed.name = flag.trim()
            if (!parsed.name) return null
            index += 1
            continue
        }
        const value = args[index + 1]?.trim()
        if (!value) return null
        if (flag === '--name' && !parsed.name) parsed.name = value
        else if (flag === '--hub' && !parsed.hubUrl) parsed.hubUrl = value
        else if (flag === '--registration-secret' && !parsed.registrationSecret) parsed.registrationSecret = value
        else if (flag === '--output-token-file' && !parsed.outputTokenFile) parsed.outputTokenFile = value
        else return null
        index += 2
    }
    return parsed
}

function defaultWorkspaceName(): string {
    try {
        const username = userInfo().username.trim()
        if (username) return username.slice(0, 64)
    } catch {}
    return hostname().trim().slice(0, 64) || 'My workspace'
}

export async function handleWorkspaceCommand(args: string[]): Promise<void> {
    const parsed = parseWorkspaceRegisterArgs(args)
    if (!parsed) {
        console.log(`
${chalk.bold('shapi workspace')} - Workspace registration

${chalk.bold('Usage:')}
  shapi workspace register [--name <name>] [--hub <url>] [--registration-secret <secret>]
                           [--output-token-file <path>]
`)
        return
    }
    const hubUrl = await resolveAuthV2HubUrl(parsed.hubUrl)
    const name = parsed.name ?? defaultWorkspaceName()
    if (name.length > 64) throw new Error('Workspace name must be at most 64 characters')
    const webToken = `spw${randomBytes(32).toString('base64url')}`
    const result = await registerWorkspace(hubUrl, { name, webToken }, parsed.registrationSecret)
    if (parsed.outputTokenFile) {
        await writeFile(parsed.outputTokenFile, `${webToken}\n`, { mode: 0o600 })
        await chmod(parsed.outputTokenFile, 0o600).catch(() => {})
    }
    console.log(chalk.green(`Workspace "${result.workspace.name}" registered.`))
    console.log(chalk.yellow('Save this Web credential now. It will not be shown again:'))
    console.log(webToken)
}

export const workspaceCommand: CommandDefinition = {
    name: 'workspace',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleWorkspaceCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
            process.exit(1)
        }
    }
}
