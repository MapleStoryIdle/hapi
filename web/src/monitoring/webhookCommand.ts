export function monitorWebhookUrl(baseUrl: string, token: string): string {
    return `${baseUrl.replace(/\/$/, '')}/hooks/events?${new URLSearchParams({ token })}`
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }

export function monitorWebhookCurl(baseUrl: string, token: string, prompt: string, data: Record<string, unknown> = { key: 'value' }): string {
    return [`curl -X POST ${shellQuote(monitorWebhookUrl(baseUrl, token))}`, "  -H 'Content-Type: application/json'", `  --data-raw ${shellQuote(JSON.stringify({ prompt, data }))}`].join(' \\\n')
}
