import { resolve } from 'node:path'
import { createConfiguration } from './configuration'
import { loadManagedSkillBundle } from './managedSkillBundles'
import { Store } from './store'

function usage(): string {
    return [
        'Usage:',
        '  shapi hub skills publish <skill-directory>',
        '  shapi hub skills list [skill-id]',
        '  shapi hub skills activate <skill-id> <version>',
        '',
        'These server-local commands manage public Skills shared by every workspace.',
        'Publishing writes the bundle to the Hub database and activates it immediately.',
        'Activating an older version performs an immediate rollback. The running Hub does not need a restart.'
    ].join('\n')
}

export async function runManagedSkillAdminCommand(args: string[]): Promise<void> {
    const action = args[0]
    if (!action || action === '--help' || action === '-h') {
        console.log(usage())
        return
    }

    const configuration = await createConfiguration()
    const store = new Store(configuration.dbPath)
    try {
        if (action === 'publish' && args.length === 2) {
            const definition = await loadManagedSkillBundle(resolve(args[1]!))
            const result = store.managedSkillPackages.publish(definition)
            console.log(`${result.created ? 'Published' : 'Activated'} public Skill ${definition.id}@${definition.version}`)
            console.log(`SHA-256: ${result.sha256}`)
            console.log('The running Hub will use this version immediately; no restart is required.')
            return
        }

        if (action === 'activate' && args.length === 3) {
            const definition = store.managedSkillPackages.activate(args[1]!, args[2]!)
            console.log(`Activated ${definition.id}@${definition.version}`)
            console.log('The running Hub will use this version immediately; no restart is required.')
            return
        }

        if (action === 'list' && args.length <= 2) {
            const versions = store.managedSkillPackages.listVersions(args[1])
            if (versions.length === 0) {
                console.log('No managed Skills found.')
                return
            }
            for (const item of versions) {
                console.log(`${item.active ? '*' : ' '} ${item.id}@${item.version}  ${item.sha256.slice(0, 12)}  ${item.source}`)
            }
            return
        }

        throw new Error(usage())
    } finally {
        store.close()
    }
}
