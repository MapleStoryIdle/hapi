process.env.DEV = 'false'

const [{ runCliCore }, { resolveRunnerCommand }] = await Promise.all([
    import('./commands/runCliCore'),
    import('./commands/runnerRegistry')
])

await runCliCore(resolveRunnerCommand)

export {}
