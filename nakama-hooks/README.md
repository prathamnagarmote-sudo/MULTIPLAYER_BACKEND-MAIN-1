Nakama Hooks - game_server_hooks

Purpose

- Provide a place to implement a Nakama matchmaking hook that spawns one mirror game server per match through the Game Servers backend.

Recommended approach

- Build a custom Nakama Docker image that includes the compiled runtime modules in `/nakama/data/modules`.

Files

- `Dockerfile` - multi-stage build that compiles TypeScript and copies the output into the Nakama image.
- `src/game_server_hooks.ts` - example TypeScript runtime module that registers `registerMatchmakerMatched` and a minimal authoritative match handler, then calls the backend spawn/stop HTTP APIs internally.
- `.github/workflows/publish.yml` - GitHub Actions workflow to build and push the custom image to GHCR.
- `deploy/docker-compose.yml` - compose template for the VPS/Server host that runs PostgreSQL and the custom Nakama image together.
- `deploy/local.yml` - Nakama runtime config used by the compose stack.
- `.env.example` - runtime env example for the VPS/Server host.
- `package.json` and `tsconfig.json` - TypeScript build configuration.

Usage

1. Build and push the image via GitHub Actions or locally:

```bash
# install build dependencies
npm install

# validate TypeScript
npm run typecheck

# build the custom image
docker build -t ghcr.io/<owner>/nakama-custom:<sha> .
```

2. On the VPS/Server host, keep the stack definition in compose form. Copy the files from `deploy/` into a directory such as `/opt/multiplayer-platform/infra/nakama`, edit `local.yml` with your real Nakama console/session/runtime keys, and place your `.env` next to `docker-compose.yml`. The Compose startup script writes a small `runtime-env.yml` overlay from `GAME_SERVERS_URL` and `INTERNAL_HOOK_SECRET`, so those values reach Nakama through `runtime.env` even in a blue/green deployment. The workflow supplies `NAKAMA_IMAGE` at deploy time, so you do not need to rewrite the file on every release.

If you want plain `docker compose up/stop` without `--env-file`, keep the host file named `.env`. Compose reads that file for `${...}` interpolation before Nakama starts; Nakama itself receives the values later through `runtime.env`, and the JavaScript hook reads them from `ctx.env`.

The runtime entrypoint stays `main.js`, and that file imports the individual hook modules. Add new hook files alongside `game_server_hooks.ts` and register them from `src/main.ts`.

3. Update the VPS/Server host so its compose file uses the custom GHCR image for Nakama. The workflow logs in to GHCR, injects `NAKAMA_IMAGE` when calling `docker compose`, pulls the image, and runs `docker compose up -d` from the compose directory.

4. If the VPS/Server host already has a hand-written compose file, only the Nakama image line and env file contents need to change. PostgreSQL still comes from compose; the workflow does not provision it.

Notes

- The hook uses `registerMatchmakerMatched` to create the mirror server only when matchmaking succeeds.
- Match metadata for clients comes from the match label returned by `matchInit`, not from the matchmaking hook return value.
- Secure the backend `POST /api/game-servers/*` with an internal auth header; the example uses `X-Internal-Auth`.
- Nakama exposes `runtime.env` on the `InitModule` context as `ctx.env`. Read hook settings from that object during startup instead of using `process.env` or initializer config getters.
