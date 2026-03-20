export async function geminiGenerate(
  apiKey: string,
  parts: { text: string }[]
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: parts.map(p => p.text).join('\n')
      }]
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Claude ${response.status}: ${err}`)
  }

  const data = await response.json()
  return data.content[0].text
}
