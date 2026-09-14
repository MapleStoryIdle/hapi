import chalk from 'chalk'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { configuration } from '@/configuration'
import { stopRunner } from '@/runner/controlClient'
import type { CommandDefinition } from './types'

const PATH_MARKER = '# Added by SHAPI installer'
const MANAGED_PATH_LINES = new Set([
    'export PATH="$HOME/.local/bin:$PATH"',
    'fish_add_path "$HOME/.local/bin"'
])

export function parseUninstallArgs(args: string[]): { purge: boolean } {
    if (args.length === 0) return { purge: false }
    if (args.length === 1 && args[0] === '--purge') return { purge: true }
    throw new Error('Usage: shapi uninstall [--purge]')
}

async function removeManagedPathEntries(homeDir: string): Promise<void> {
    const files = [
        join(homeDir, '.zshrc'),
        join(homeDir, '.bashrc'),
        join(homeDir, '.profile'),
        join(homeDir, '.config', 'fish', 'config.fish')
    ]
    for (const path of files) {
        let contents: string
        try {
            contents = await readFile(path, 'utf8')
        } catch {
            continue
        }
        const lines = contents.split('\n')
        const filtered: string[] = []
        for (let index = 0; index < lines.length; index++) {
            if (lines[index] === PATH_MARKER && MANAGED_PATH_LINES.has(lines[index + 1] ?? '')) {
                index += 1
                continue
            }
            filtered.push(lines[index]!)
        }
        const next = filtered.join('\n')
        if (next !== contents) await writeFile(path, next, 'utf8')
    }
}

export async function uninstallShapi(options: {
    purge: boolean
    executablePath?: string
    hapiHome?: string
    homeDir?: string
    output?: (message: string) => void
}): Promise<void> {
    const executablePath = options.executablePath ?? process.execPath
    const executableName = basename(executablePath)
    if (executableName !== 'shapi' && executableName !== 'hapi') {
        throw new Error('Uninstall must be run from an installed shapi or hapi executable')
    }
    const output = options.output ?? console.log
    const hapiHome = options.hapiHome ?? configuration.happyHomeDir
    const homeDir = options.homeDir ?? homedir()

    await stopRunner().catch(() => {})
    if (options.purge) {
        await rm(hapiHome, { recursive: true, force: true })
    } else {
        await Promise.all([
            rm(join(hapiHome, 'logs'), { recursive: true, force: true }),
            rm(join(hapiHome, 'runtime'), { recursive: true, force: true }),
            rm(join(hapiHome, 'runner.state.json'), { force: true }),
            rm(join(hapiHome, 'runner.state.json.lock'), { force: true })
        ])
    }
    await removeManagedPathEntries(homeDir)

    const installDir = dirname(executablePath)
    await Promise.all([
        rm(join(installDir, 'shapi'), { force: true }),
        rm(join(installDir, 'hapi'), { force: true }),
        rm(join(installDir, 'shapi.previous'), { force: true }),
        rm(join(installDir, '.shapi.next'), { force: true })
    ])

    output(options.purge
        ? 'SHAPI uninstalled. Local settings and credentials were removed.'
        : 'SHAPI uninstalled. Local settings and credentials were preserved.')
}

export const uninstallCommand: CommandDefinition = {
    name: 'uninstall',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await uninstallShapi(parseUninstallArgs(commandArgs))
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
            process.exit(1)
        }
    }
}
