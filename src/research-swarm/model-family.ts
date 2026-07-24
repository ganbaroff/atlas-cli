/**
 * Map provider + modelId to a model family for diversity/consensus checks.
 */

export function modelFamily(provider: string, modelId: string): string {
  const p = provider.toLowerCase();
  const m = modelId.toLowerCase();

  if (m.includes('claude') || p === 'anthropic') return 'claude';
  if (m.includes('gpt') || p === 'openai' || p === 'azure') return 'gpt';
  if (m.includes('gemini') || p === 'gemini' || (p === 'freellmapi' && m.includes('gemini'))) return 'gemini';
  if (m.includes('grok') || m.includes('x-ai')) return 'grok';
  if (m.includes('qwen') || p === 'ollama' && m.includes('qwen')) return 'qwen';
  if (m.includes('llama') || m.includes('meta/') || p === 'groq' || p === 'nvidia') return 'llama';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('deepseek')) return 'deepseek';

  return `${p}:${m.split('/').pop()?.split(':')[0] ?? 'unknown'}`;
}
