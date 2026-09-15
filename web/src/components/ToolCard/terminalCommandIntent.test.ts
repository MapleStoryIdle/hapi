import { describe, expect, it } from 'vitest'
import { getTerminalCommandDisplayTitle, getTerminalCommandIntent, getTerminalCommandIntentDetail, getTerminalCommandIntentLabel, getTerminalCommandIntentTitle, getTerminalCommandSummary, usesTerminalCommandAsLabel, joinTerminalSummaryParts } from '@/components/ToolCard/terminalCommandIntent'

describe('terminal command intent', () => {
    it('joins summary fragments once, without dangling or duplicate separators', () => {
        expect(joinTerminalSummaryParts(['git status;', '; git diff; ', '3s'])).toBe('git status; git diff; 3s')
        expect(joinTerminalSummaryParts(['git status', '', null, undefined])).toBe('git status')
        expect(joinTerminalSummaryParts(['GET · example.com/api', '2s'])).toBe('GET · example.com/api; 2s')
        expect(joinTerminalSummaryParts(['', ';', null])).toBe('')
    })
    it('keeps shell file reads as requests and includes their explicit targets', () => {
        expect(getTerminalCommandIntent({
            command: `/bin/zsh -lc "cat package.json; find src -type f | sort; sed -n '1,220p' README.md"`
        })).toEqual({
            kind: 'read-request',
            targets: [
                { path: 'package.json', lineRange: null },
                { path: 'README.md', lineRange: { start: 1, end: 220 } }
            ]
        })
    })

    it.each([
        ['bun run typecheck && bun run test', 'run-checks'],
        ['bunx vitest run src/App.test.tsx', 'run-tests'],
        ['rg -n "ToolGroupCard" web/src', 'search-files'],
        ['git -C /workspace/hapi status --short; git diff --stat', 'inspect-git'],
        ['find web/src -type f | sort', 'browse-files'],
        ['bun run build', 'build-project']
    ] as const)('classifies %s as %s', (command, kind) => {
        expect(getTerminalCommandIntent({ command })).toMatchObject({ kind })
    })

    it('describes common real-world terminal work without exposing command arguments', () => {
        expect(getTerminalCommandIntent({ command: "python3 - <<'PY'\ngit status\nPY" })).toEqual({
            kind: 'run-program',
            program: 'Python'
        })
        expect(getTerminalCommandIntent({ command: "node -e 'process.exit(0)'" })).toEqual({
            kind: 'run-program',
            program: 'Node.js'
        })
        expect(getTerminalCommandIntent({ command: 'curl -H "Authorization: Bearer secret" https://example.com' })).toEqual({
            kind: 'request-url',
            method: 'GET',
            host: 'example.com',
            path: null
        })
        expect(getTerminalCommandIntent({ command: 'ssh server-alias systemctl status app' })).toEqual({
            kind: 'remote-command',
            executable: 'ssh',
            host: 'server-alias',
            mode: 'execute',
            action: { kind: 'manage-service', operation: 'inspect', service: 'app' },
            files: []
        })
        expect(getTerminalCommandIntent({ command: 'ps aux | grep worker' })).toEqual({ kind: 'inspect-processes' })
        expect(getTerminalCommandIntent({ command: 'sleep 5' })).toEqual({ kind: 'wait' })
        expect(getTerminalCommandIntent({ command: 'project-dbcli query --password secret' })).toEqual({
            kind: 'query-database',
            database: null,
            tables: []
        })
        expect(getTerminalCommandIntent({ command: 'tail -n 80 /var/log/app.log' })).toEqual({
            kind: 'inspect-output',
            files: ['app.log']
        })
        expect(getTerminalCommandIntent({ command: 'systemctl is-active app.service' })).toEqual({
            kind: 'manage-service',
            operation: 'inspect',
            service: 'app'
        })
        expect(getTerminalCommandIntent({ command: '/opt/tools/upgrade_remote_hapi_hub.sh server-alias' })).toEqual({ kind: 'manage-hapi' })
        expect(getTerminalCommandIntent({ command: 'shapi runner status' })).toEqual({ kind: 'manage-hapi' })
        expect(getTerminalCommandIntent({ command: 'kill 12345' })).toEqual({ kind: 'stop-process' })
        expect(getTerminalCommandIntent({ command: 'find . -name tmp -delete' })).toEqual({
            kind: 'manage-files',
            files: ['tmp'],
            move: null
        })
        expect(getTerminalCommandIntent({ command: 'gofmt -w ./internal' })).toEqual({ kind: 'format-code' })

        const title = getTerminalCommandDisplayTitle({ command: '/opt/tools/reindex-cli --token must-not-render' })
        expect(title).toBe('Run reindex-cli')
        expect(title).not.toContain('must-not-render')
        expect(getTerminalCommandDisplayTitle({ command: '$SECRET_TOOL --token must-not-render' })).toBeNull()
    })

    it('shows safe targets while omitting credentials, SQL values, and file directories', () => {
        const request = getTerminalCommandIntent({
            command: `curl -X POST -H 'Authorization: Bearer secret' 'https://user:password@192.0.2.18:8080/api/order/status?token=secret'`
        })
        expect(request).toEqual({
            kind: 'request-url',
            method: 'POST',
            host: '192.0.2.18:8080',
            path: '/api/order/status'
        })
        expect(request && getTerminalCommandIntentDetail(request)).toBe('192.0.2.18:8080/api/order/status')

        const requestWithUrlBody = getTerminalCommandIntent({
            command: `curl -d 'https://secret.example/payload' https://api.example/status`
        })
        expect(requestWithUrlBody && getTerminalCommandIntentDetail(requestWithUrlBody)).toBe('api.example/status')

        const remote = getTerminalCommandIntent({
            command: 'ssh deploy@192.0.2.18 systemctl restart hapi-hub.service'
        })
        expect(remote && getTerminalCommandIntentTitle(remote)).toBe('ssh')
        expect(remote && getTerminalCommandIntentDetail(remote)).toBe('192.0.2.18')
        expect(getTerminalCommandDisplayTitle({
            command: 'ssh deploy@192.0.2.18 systemctl restart hapi-hub.service'
        })).toBe('ssh · 192.0.2.18')
        expect(getTerminalCommandDisplayTitle({
            command: 'ssh 192.0.2.18 echo must-not-render'
        })).toBe('ssh · 192.0.2.18')
        expect(getTerminalCommandDisplayTitle({
            command: 'scp -i /credentials/private-key /build/hapi deploy@192.0.2.18:/tmp/hapi'
        })).toBe('scp · 192.0.2.18')

        expect(getTerminalCommandDisplayTitle({
            command: 'curl https://example.com/api'
        })).toBe('GET · example.com/api')

        const database = getTerminalCommandIntent({
            command: `mysql --database lingda_dev -e "SELECT password FROM sys_user WHERE token = 'must-not-render'"`
        })
        expect(database).toEqual({
            kind: 'query-database',
            database: 'lingda_dev',
            tables: ['sys_user']
        })
        expect(database && getTerminalCommandIntentTitle(database)).toBe('Execute SQL')
        expect(database && getTerminalCommandIntentDetail(database)).toBe('lingda_dev.sys_user')
        expect(getTerminalCommandDisplayTitle({
            command: `psql -d lingda_dev -c 'SELECT "from must_not_render"'`
        })).toBe('Execute SQL · lingda_dev')

        const moved = getTerminalCommandIntent({ command: 'mv web/src/old.ts web/src/new.ts' })
        expect(moved && getTerminalCommandIntentDetail(moved)).toBe('old.ts → new.ts')
        const searchedInput = { command: 'rg -n ToolCard web/src/components/ToolCard/knownTools.tsx' }
        const searched = getTerminalCommandIntent(searchedInput)
        expect(searched && getTerminalCommandIntentTitle(searched)).toBe('Search files')
        expect(searched && getTerminalCommandIntentDetail(searched)).toBe('knownTools.tsx')
        expect(searched && getTerminalCommandIntentLabel(searchedInput, searched)).toBe('rg')
        expect(getTerminalCommandDisplayTitle(searchedInput)).toBe('rg · knownTools.tsx')

        const searchedMany = getTerminalCommandIntent({
            command: 'rg -n ToolCard web/src/a.ts web/src/b.ts web/src/c.ts web/src/d.ts web/src/e.ts'
        })
        expect(searchedMany && getTerminalCommandIntentDetail(searchedMany)).toBe('5 files')

        const readMany = getTerminalCommandIntent({
            command: "cat web/src/a.ts; sed -n '1,20p' web/src/b.ts"
        })
        expect(readMany && getTerminalCommandIntentDetail(readMany)).toBe('2 files')
        expect(readMany && getTerminalCommandIntentDetail(readMany, (key, params) => (
            key === 'toolGroup.compact.fileCount' ? `${params?.n} 个文件` : key
        ))).toBe('2 个文件')

        const grepInput = { command: 'grep -n ToolCard web/src/components/ToolCard/knownTools.tsx' }
        const grep = getTerminalCommandIntent(grepInput)
        expect(grep && getTerminalCommandIntentLabel(grepInput, grep)).toBe('grep')
        expect(getTerminalCommandDisplayTitle(grepInput)).toBe('grep · knownTools.tsx')

        const rendered = [
            request && getTerminalCommandDisplayTitle({ command: `curl -X POST 'https://user:password@192.0.2.18:8080/api/order/status?token=secret'` }),
            database && getTerminalCommandIntentDetail(database),
            moved && getTerminalCommandIntentDetail(moved)
        ].join(' ')
        expect(rendered).not.toContain('password')
        expect(rendered).not.toContain('must-not-render')
        expect(rendered).not.toContain('web/src')
    })

    it('uses clear fallback titles outside the translation provider', () => {
        const intent = getTerminalCommandIntent({ command: 'git diff -- web/src/App.tsx' })
        expect(intent && getTerminalCommandIntentTitle(intent)).toBe('Inspect Git')
    })

    it('uses the native read-file title for terminal read requests', () => {
        const intent = getTerminalCommandIntent({ command: "sed -n '12,80p' web/src/App.tsx" })
        const receivedKeys: string[] = []

        expect(intent && getTerminalCommandIntentTitle(intent, (key) => {
            receivedKeys.push(key)
            return '读取文件'
        })).toBe('读取文件')
        expect(receivedKeys).toEqual(['tool.semanticTitle.readFile'])
    })

    it('uses the actual package command as the label for runnable project scripts', () => {
        const input = { command: '/bin/zsh -lc "echo start; bun run typecheck && bun run test; printf done"' }
        const intent = getTerminalCommandIntent(input)

        expect(intent && usesTerminalCommandAsLabel(intent)).toBe(true)
        expect(intent && getTerminalCommandIntentLabel(input, intent)).toBe('bun run typecheck; bun run test')
    })

    it('keeps one or two recognized commands instead of the full shell script', () => {
        expect(getTerminalCommandSummary({
            command: 'git -C /workspace/hapi status --short; rg -n "ToolGroupCard" web/src; echo done'
        })).toBe('git status; rg')
        expect(getTerminalCommandSummary({
            command: 'node scripts/rewrite.mjs --verbose --all'
        })).toBeNull()
        expect(getTerminalCommandSummary({
            command: 'apply_patch <<PATCH\n*** Begin Patch'
        })).toBe('apply_patch')
        expect(getTerminalCommandSummary({
            command: '/bin/zsh -lc "sed -n \'1,20p\' src/App.tsx; for f in src/a.ts; do echo $f; done\''
        })).toBe('sed -n')
    })

    it('extracts key commands from a Codex Desktop orchestration wrapper', () => {
        const input = {
            command: `const results = await Promise.all([
                tools.exec_command({ cmd: "git status --short; git diff --stat", workdir: "/repo" }),
                tools.exec_command({ cmd: "bun run test", workdir: "/repo" })
            ]); text(results.length);`
        }

        expect(getTerminalCommandSummary(input)).toBe('git status; git diff; +1')
        expect(getTerminalCommandDisplayTitle(input)).toBe('git status; git diff; +1')
    })

    it('does not expose Codex Desktop orchestration as Run const', () => {
        expect(getTerminalCommandDisplayTitle({
            command: 'const matches = ALL_TOOLS.filter((tool) => tool.name); text(matches);'
        })).toBe('Tool operation')

        expect(getTerminalCommandDisplayTitle({
            command: 'const result = await tools.browser_check({ url: "http://localhost", title: "Check local preview" }); text(result);'
        })).toBe('Check local preview')

        const receivedKeys: string[] = []
        expect(getTerminalCommandDisplayTitle({
            command: 'const result = await tools.exec_command({ cmd: buildCommand() }); text(result);'
        }, (key) => {
            receivedKeys.push(key)
            return '执行工具命令'
        })).toBe('执行工具命令')
        expect(receivedKeys).toEqual(['terminal.execution.execCommandFallback'])
    })
})
