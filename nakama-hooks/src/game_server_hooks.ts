type HttpResponse = {
  code: number;
  body?: string;
};

const BACKEND_HTTP_TIMEOUT_MS = 60000;

type MatchLabel = {
  matchPath: string;
  gameType: string;
};

export const GAME_SERVER_MATCH_MODULE = "game-server";

const runtimeSettings: Record<string, string> = {};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readRuntimeSetting(ctx: any, key: string): string {
  const env = ctx && ctx.env ? ctx.env : {};

  if (env && typeof env === "object" && !Array.isArray(env)) {
    const value = env[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return runtimeSettings[key] || "";
}

function getBackendBaseUrl(ctx: any): string {
  const backendBaseUrl = readRuntimeSetting(ctx, "GAME_SERVERS_URL") || "http://host.docker.internal:3001";

  if (!isNonEmptyString(backendBaseUrl)) {
    throw new Error("GAME_SERVERS_URL is not configured in Nakama runtime.env");
  }

  return backendBaseUrl.replace(/\/+$/, "");
}

function getInternalSecret(ctx: any): string {
  const internalHookSecret = readRuntimeSetting(ctx, "INTERNAL_HOOK_SECRET");

  if (!isNonEmptyString(internalHookSecret)) {
    throw new Error("INTERNAL_HOOK_SECRET is not configured in Nakama runtime.env");
  }

  return internalHookSecret;
}

export function isInternalSecretConfigured(): boolean {
  return isNonEmptyString(runtimeSettings.INTERNAL_HOOK_SECRET);
}

export function isBackendUrlConfigured(): boolean {
  return isNonEmptyString(runtimeSettings.GAME_SERVERS_URL);
}

export function loadRuntimeSettings(ctx: any): void {
  // Clear previous settings
  for (const k of Object.keys(runtimeSettings)) {
    delete runtimeSettings[k];
  }

  const env = ctx && ctx.env ? ctx.env : {};

  // If env is an array of strings like ["KEY=VALUE", ...], parse those entries.
  if (Array.isArray(env)) {
    for (const entry of env) {
      if (typeof entry === "string") {
        const idx = entry.indexOf("=");
        if (idx > 0) {
          const key = entry.substring(0, idx);
          const value = entry.substring(idx + 1);
          if (key) {
            runtimeSettings[key] = value;
          }
        }
      } else if (entry && typeof entry === "object") {
        for (const key of Object.keys(entry)) {
          const value = entry[key];
          if (typeof value === "string" && key) {
            runtimeSettings[key] = value;
          }
        }
      }
    }
    return;
  }

  // If env is an object/map, copy string values directly.
  if (env && typeof env === "object") {
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (typeof value === "string" && key) {
        runtimeSettings[key] = value;
      }
    }
  }
}

function buildHeaders(ctx: any): Record<string, string> {
  const internalHookSecret = getInternalSecret(ctx);

  return {
    "Content-Type": "application/json",
    "X-Internal-Auth": internalHookSecret,
  };
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function buildMatchPath(matchId: string): string {
  return "/match/" + matchId;
}

function parseGameType(matches: any[]): string {
  if (!matches || matches.length === 0) {
    return "default";
  }

  const firstMatch = matches[0];
  if (
    firstMatch &&
    firstMatch.properties &&
    isNonEmptyString(firstMatch.properties.gameType)
  ) {
    return firstMatch.properties.gameType;
  }

  return "default";
}

function stopSpawnedServer(nk: any, ctx: any, matchId: string): void {
  try {
    postJson(nk, ctx, "/api/game-servers/stop", { matchId: matchId });
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

function spawnGameServer(nk: any, ctx: any, matchId: string, gameType: string): HttpResponse {
  return postJson(nk, ctx, "/api/game-servers/spawn", {
    matchId: matchId,
    gameType: gameType,
  });
}

function bindMatchRoute(nk: any, ctx: any, matchId: string, serverMatchId: string): HttpResponse {
  return postJson(nk, ctx, '/api/game-servers/bind-route', {
    matchId: matchId,
    serverMatchId: serverMatchId,
  });
}

export function gameServerMatchInit(_ctx: any, logger: any, _nk: any, params: any) {
  const matchPath = isNonEmptyString(params.matchPath) ? params.matchPath : "";
  const gameType = isNonEmptyString(params.gameType) ? params.gameType : "default";
  const serverMatchId = isNonEmptyString(params.serverMatchId) ? params.serverMatchId : "";

  const label: MatchLabel = {
    matchPath: matchPath,
    gameType: gameType,
  };

  logger.info("game server match initialized: %s", JSON.stringify(label));

  return {
    state: {
      matchPath: matchPath,
      gameType: gameType,
      serverMatchId: serverMatchId,
    },
    tickRate: 1,
    label: JSON.stringify(label),
  };
}

export function gameServerMatchJoinAttempt(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _presence: any,
  _metadata: { [key: string]: any },
) {
  return { state: state, accept: true };
}

export function gameServerMatchJoin(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _presences: any[],
) {
  return { state: state };
}

export function gameServerMatchLeave(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _presences: any[],
) {
  return { state: state };
}

export function gameServerMatchLoop(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _messages: any[],
) {
  return { state: state };
}

export function gameServerMatchTerminate(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _graceSeconds: number,
) {
  if (state && isNonEmptyString(state.serverMatchId)) {
    stopSpawnedServer(_nk, _ctx, state.serverMatchId);
  }

  return { state: state };
}

export function gameServerMatchSignal(
  _ctx: any,
  _logger: any,
  _nk: any,
  _dispatcher: any,
  _tick: number,
  state: any,
  _data: string,
) {
  return { state: state };
}

export function matchmakerMatched(_ctx: any, logger: any, nk: any, matches: any[]): string {
  const gameType = parseGameType(matches);
  const serverMatchId = nk.uuidv4();
  const matchPath = buildMatchPath(serverMatchId);

  logger.info(
    "matchmakerMatched triggered: gameType=%s matchPath=%s matches=%s",
    gameType,
    matchPath,
    matches ? String(matches.length) : "0",
  );

  const spawnResponse = spawnGameServer(nk, _ctx, serverMatchId, gameType);

  if (!isSuccess(spawnResponse.code)) {
    logger.error("matchmakerMatched spawn failed", spawnResponse);
    throw new Error("Failed to spawn game server");
  }

  try {
    const matchId = nk.matchCreate(GAME_SERVER_MATCH_MODULE, {
      matchPath: matchPath,
      gameType: gameType,
      serverMatchId: serverMatchId,
    });

    const bindResponse = bindMatchRoute(nk, _ctx, matchId, serverMatchId);

    if (!isSuccess(bindResponse.code)) {
      stopSpawnedServer(nk, _ctx, serverMatchId);
      logger.error("matchmakerMatched bind-route failed", bindResponse);
      throw new Error("Failed to bind game server route");
    }

    logger.info(
      "matchmakerMatched created Nakama match: matchId=%s matchPath=%s",
      matchId,
      matchPath,
    );

    return matchId;
  } catch (error) {
    stopSpawnedServer(nk, _ctx, serverMatchId);
    logger.error("matchmakerMatched matchCreate failed", error);
    throw new Error("Failed to create Nakama match");
  }
}

function postJson(nk: any, ctx: any, path: string, body: unknown): HttpResponse {
  return nk.httpRequest(
    getBackendBaseUrl(ctx) + path,
    "POST",
    buildHeaders(ctx),
    JSON.stringify(body),
    BACKEND_HTTP_TIMEOUT_MS,
  ) as HttpResponse;
}

export function registerGameServerHooks(
  logger: any,
  nk: any,
  initializer: any,
): void {
  initializer.registerMatchmakerMatched(matchmakerMatched);

  initializer.registerMatch(GAME_SERVER_MATCH_MODULE, {
    matchInit: gameServerMatchInit,
    matchJoinAttempt: gameServerMatchJoinAttempt,
    matchJoin: gameServerMatchJoin,
    matchLeave: gameServerMatchLeave,
    matchLoop: gameServerMatchLoop,
    matchTerminate: gameServerMatchTerminate,
    matchSignal: gameServerMatchSignal,
  });

  logger.info("game_server_hooks module initialized");
}
