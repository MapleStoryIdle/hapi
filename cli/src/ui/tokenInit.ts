/**
 * Token initialization module
 *
 * Handles CLI_API_TOKEN initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Approved auth-v2 runner credential for the configured Hub
 * 3. Legacy settings file token (~/.hapi/settings.json)
 * 4. Interactive prompt (only when all above are missing)
 */

import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import chalk from 'chalk'
import { exportHapiHubApiUrl } from '@/agent/hapiSessionEnv'
import { configuration } from '@/configuration'
import { readSettings, updateSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import { readRunnerCredential } from '@/authV2/credentials'

/**
 * Initialize CLI API token
 * Must be called before any API operations
 */
export async function initializeToken(): Promise<void> {
    // Initialize API URL first (env > settings.json > default)
    const apiUrlSource = await initializeApiUrl()
    const exportApiUrl = apiUrlSource !== 'default'

    // 1. Environment variable has highest priority (allows temporary override)
    if (configuration.cliApiToken) {
        exportHapiHubApiUrl({ exportApiUrl })
        return
    }

    // 2. Read auth-v2 and legacy credentials from local storage
    const settings = await readSettings()
    const runnerCredential = await readRunnerCredential(configuration.apiUrl)
    if (runnerCredential?.status === 'approved') {
        configuration._setCliApiToken(runnerCredential.runnerToken)
        if (settings.machineId !== runnerCredential.machineId) {
            await updateSettings(current => ({ ...current, machineId: runnerCredential.machineId }))
        }
        exportHapiHubApiUrl({ exportApiUrl })
        return
    }
    if (settings.cliApiToken) {
        configuration._setCliApiToken(settings.cliApiToken)
        exportHapiHubApiUrl({ exportApiUrl })
        return
    }

    // 3. Non-TTY environment cannot prompt, fail with clear error
    if (!process.stdin.isTTY) {
        throw new Error('Runner credentials are required. Run `shapi runner pair` or set CLI_API_TOKEN.')
    }

    // 4. Interactive prompt
    const token = await promptForToken()

    // 5. Save and update configuration
    await updateSettings(current => ({
        ...current,
        cliApiToken: token
    }))
    configuration._setCliApiToken(token)
    exportHapiHubApiUrl({ exportApiUrl })
}

async function promptForToken(): Promise<string> {
    const rl = readline.createInterface({ input, output })

    console.log(chalk.yellow('\nNo CLI_API_TOKEN found.'))
    console.log(chalk.gray('Where to find the token:'))
    console.log(chalk.gray('  1. Check the server startup logs (first run shows generated token)'))
    console.log(chalk.gray('  2. Read ~/.hapi/settings.json on the server'))
    console.log(chalk.gray('  3. Ask your server administrator (if token is set via env var)\n'))

    try {
        const token = await rl.question(chalk.cyan('Enter CLI_API_TOKEN: '))
        if (!token.trim()) {
            throw new Error('Token cannot be empty')
        }
        console.log(chalk.green(`\nToken saved to ${configuration.settingsFile}`))
        return token.trim()
    } finally {
        rl.close()
    }
}
