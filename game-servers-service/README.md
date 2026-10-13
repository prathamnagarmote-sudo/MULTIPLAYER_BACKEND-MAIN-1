# Game Servers Service

A lightweight, standalone NestJS microservice responsible for orchestrating and managing dedicated Unity match servers via Docker. This service works in conjunction with Nakama to dynamically spawn, bind, and stop containerized headless game instances.

## Features

- **Dynamic Container Orchestration:** Automatically spawns Unity headless servers in Docker containers on-demand.
- **Port Management:** Dynamically allocates available host ports and binds them to the internal container ports.
- **WebSocket Routing:** Proxies WebSocket traffic through to the dynamically spawned game servers.
- **Garbage Collection:** Periodically cleans up orphaned or dead containers to prevent resource leaks.

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- [Docker](https://www.docker.com/) (Must be running and accessible by the user executing the service)
- [npm](https://www.npmjs.com/)

## Production Deployment

### Option 1: Docker Compose (recommended)

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Adjust the values in `.env` as needed.
3. Start the service:
   ```bash
   docker compose up -d --build
   ```
4. Verify the service is healthy:
   ```bash
   docker compose ps
   ```

### Important runtime requirement

The orchestrator must be able to reach the host Docker daemon so it can create game-server containers on the host machine.

This is handled by mounting the Docker socket into the container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

With this setup, the flow becomes:

```text
orchestrator container → host Docker daemon → create game server containers on the host
```

### Option 2: Run directly on the host

If you prefer not to use Docker for the orchestrator, you can run the Node service directly on the host and ensure Docker is installed there.

```bash
npm install
npm run build
npm run start:prod
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run build
$ npm run start:prod
```

## API Endpoints

All endpoints require the `x-internal-auth` header matching the `INTERNAL_HOOK_SECRET` defined in your environment variables.

### 1. Spawn a Server
**`POST /api/game-servers/spawn`**
Spawns a new Unity headless container for a specific match.
- **Body:** `{ "matchId": "string", "gameType": "string" }`
- **Response:** `{ "matchPath": "/match/{matchId}", "alreadyRunning": false }`

### 2. Bind Route
**`POST /api/game-servers/bind-route`**
Binds a Nakama match ID to the underlying spawned Unity server route.
- **Body:** `{ "matchId": "string", "serverMatchId": "string" }`
- **Response:** `{ "success": true }`

### 3. Stop Server
**`POST /api/game-servers/stop`**
Stops and completely removes a running game server container by its Match ID.
- **Body:** `{ "matchId": "string" }`
- **Response:** `{ "success": true }`

## Architecture

This service acts strictly as an infrastructure bridge. It receives trusted HTTP webhooks (typically from Nakama) and directly executes `docker` CLI commands to spin up instances of your `GAME_SERVER_IMAGE`.

The service also relies on a cleanup interval (`GAME_SERVER_CLEANUP_INTERVAL_SECONDS`) to query Docker for containers labeled with `stacknize.managed=true` and remove ones that have exceeded their maximum lifetime or crashed.
