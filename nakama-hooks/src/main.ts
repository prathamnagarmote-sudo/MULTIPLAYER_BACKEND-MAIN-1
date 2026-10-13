import {
  GAME_SERVER_MATCH_MODULE,
  gameServerMatchInit,
  gameServerMatchJoin,
  gameServerMatchJoinAttempt,
  gameServerMatchLeave,
  gameServerMatchLoop,
  gameServerMatchSignal,
  gameServerMatchTerminate,
  isBackendUrlConfigured,
  isInternalSecretConfigured,
  loadRuntimeSettings,
  matchmakerMatched,
} from "./game_server_hooks";

function InitModule(ctx: any, logger: any, nk: any, initializer: any): void {
  loadRuntimeSettings(ctx);
  logger.info(
    "game_server_hooks runtime settings: gameServersUrlConfigured=%s internalHookSecretConfigured=%s",
    String(isBackendUrlConfigured()),
    String(isInternalSecretConfigured()),
  );

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

(globalThis as any).InitModule = InitModule;
