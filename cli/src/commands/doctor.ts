import { killRunawayHappyProcesses, previewRunawayHappyProcesses } from '@/runner/doctor'
import { runDoctorCommand } from '@/ui/doctor'
import type { CommandDefinition } from './types'

export const doctorCommand: CommandDefinition = {
    name: 'doctor',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        if (commandArgs[0] === 'processes') {
            const processes = await previewRunawayHappyProcesses()
            if (commandArgs.includes('--json')) {
                console.log(JSON.stringify(processes, null, 2))
            } else if (processes.length === 0) {
                console.log('No SHAPI-managed or SHAPI-looking processes found.')
            } else {
                console.log('Process inventory (read-only):')
                for (const item of processes) {
                    console.log(`PID ${item.pid}  ${item.reason}  ${item.command}`)
                }
            }
            process.exit(0)
        }
        if (commandArgs[0] === 'clean') {
            const result = await killRunawayHappyProcesses()
            console.log(`Dry run only: ${result.skipped.length} processes inspected; none stopped.`)
            for (const process of result.skipped) {
                console.log(`Would not stop PID ${process.pid}: ${process.reason}`)
            }
            if (result.errors.length > 0) {
                console.log('Errors:', result.errors)
            }
            process.exit(0)
        }
        await runDoctorCommand()
    }
}
