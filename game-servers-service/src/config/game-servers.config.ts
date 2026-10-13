import { registerAs } from '@nestjs/config';

const toNumber = (value: string | undefined, fallback: number) => {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export default registerAs('gameServers', () => ({
  portStart: toNumber(process.env.GAME_SERVER_PORT_START, 7900),
  portEnd: toNumber(process.env.GAME_SERVER_PORT_END, 8900),
  routerPort: toNumber(process.env.GAME_SERVER_ROUTER_PORT, 4000),
  internalHookSecret: process.env.INTERNAL_HOOK_SECRET || '',
  image: process.env.GAME_SERVER_IMAGE || '',
  dockerNetwork:
    process.env.GAME_SERVER_DOCKER_NETWORK || 'multiplayer-platform-net',
  memoryLimit: process.env.GAME_SERVER_MEMORY_LIMIT || '400m',
  cpuLimit: process.env.GAME_SERVER_CPU_LIMIT || '0.5',
  cleanupIntervalSeconds: toNumber(
    process.env.GAME_SERVER_CLEANUP_INTERVAL_SECONDS,
    30,
  ),
  maxMatchLifetimeMinutes: toNumber(
    process.env.GAME_SERVER_MAX_LIFETIME_MINUTES,
    30,
  ),
  bootTimeoutSeconds: toNumber(
    process.env.GAME_SERVER_BOOT_TIMEOUT_SECONDS,
    60,
  ),
  internalPort: toNumber(process.env.GAME_SERVER_INTERNAL_PORT, 7778),
}));
