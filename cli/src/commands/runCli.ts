import { runCliCore } from './runCliCore'
import { resolveCommand } from './registry'

export async function runCli(): Promise<void> {
    await runCliCore(resolveCommand)
}
