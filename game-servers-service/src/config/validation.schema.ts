/**
 * Environment variable validation
 * Simple validation without external dependencies
 */
export function validateEnv(): Record<string, unknown> {
  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT || '3001', 10),
  };
}
