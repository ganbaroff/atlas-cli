import { resolve } from 'node:path';

function getRootEnv(envName: string): string {
  const val = process.env[envName];
  if (val) {
    const trimmed = val.trim();
    // Check if running on non-Windows but the environment variable contains a Windows path
    if (process.platform !== 'win32' && /^[a-zA-Z]:[/\\]/.test(trimmed)) {
      console.warn(
        `[path-util] Warning: ${envName}="${trimmed}" looks like a Windows path but we are running on "${process.platform}". ` +
        `Falling back to default POSIX path to prevent garbage directories.`
      );
      return resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA');
    }
    return resolve(trimmed);
  }
  return process.platform === 'win32'
    ? 'C:\\Projects\\VOLAURA'
    : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA');
}

export function getMemoryRoot(): string {
  return getRootEnv('MEMORY_ROOT');
}

export function getVolauraRoot(): string {
  return getRootEnv('VOLAURA_ROOT');
}
