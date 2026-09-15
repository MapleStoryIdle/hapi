process.env.DEV = 'false'

const [{ runCliCore }, { resolveRunnerCommand }, { RUNNER_VERSION }] = await Promise.all([
    import('./commands/runCliCore'),
    import('./commands/runnerRegistry'),
    import('./runnerVersion')
])

await runCliCore(resolveRunnerCommand, RUNNER_VERSION)

export {}
