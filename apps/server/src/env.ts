// Errors carry a code and a message that says what to do about it.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`E_MISSING_ENV: ${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const PORT = Number(process.env['PORT'] ?? 8787);
export const HOST = process.env['HOST'] ?? '0.0.0.0';
