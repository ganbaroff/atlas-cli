/**
 * Lightweight secret scan for swarm artifacts — never prints matched secrets.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'aws_key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github_pat', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'openai_key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'supabase_jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

export function scanForSecrets(text: string): { clean: boolean; findings: string[] } {
  const findings: string[] = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) findings.push(name);
  }
  return { clean: findings.length === 0, findings };
}
