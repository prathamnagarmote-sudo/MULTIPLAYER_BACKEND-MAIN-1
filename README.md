# Multiplayer Backend

A TypeScript-based multiplayer infrastructure backend for orchestrating Dockerized game servers with Nakama matchmaking.

This repository connects gameplay matchmaking to dedicated runtime servers, enabling dynamic per-match server creation, WebSocket routing, and automatic cleanup of expired game sessions.

## Overview

The project is split into two main components:

- `game-servers-service`: a NestJS backend that manages Docker containers for dedicated match servers
- `nakama-hooks`: Nakama runtime hooks that trigger server creation when matchmaking succeeds

Together, they provide a lightweight multiplayer platform layer for games that need isolated match instances, server lifecycle automation, and internal orchestration APIs.

## Architecture

```text
Nakama Matchmaker
        |
        v
nakama-hooks
        |
        |-- spawn / bind / stop requests
        v
game-servers-service
        |
        |-- Docker run / inspect / rm
        v
Dedicated game server containers
        |
        v
WebSocket router
        |
        v
Players connect to the active match route
```

## What this project does

- Spawns a dedicated game server container for each match
- Binds a Nakama match to the spawned server route
- Routes WebSocket traffic to the correct running server
- Authenticates internal orchestration requests using a shared secret
- Cleans up expired or orphaned containers automatically
- Supports Swagger API documentation in development mode

## Repository structure

```text
Multiplayer_Backend/
├── game-servers-service/
│   ├── src/
│   ├── .env.example
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── package.json
│   ├── README.md
│   ├── tsconfig.json
│   └── ...
├── nakama-hooks/
│   ├── src/
│   ├── .env.example
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── package.json
│   ├── README.md
│   ├── tsconfig.json
│   └── ...
├── LICENSE
└── README.md
```

## Tech stack

- TypeScript
- NestJS
- Docker
- Nakama
- WebSockets
- Node.js
- Swagger / OpenAPI
- YAML-based deployment configuration

## Game servers service

The `game-servers-service` is the core orchestration layer. It exposes authenticated internal APIs for:

- spawning a server
- binding a match route
- stopping and cleaning up a server

Example API routes:

- `POST /api/game-servers/spawn`
- `POST /api/game-servers/bind-route`
- `POST /api/game-servers/stop`

All internal calls require the `X-Internal-Auth` header to match the configured secret.

## Nakama hooks

The `nakama-hooks` module listens to Nakama matchmaking events and triggers the backend service to provision match infrastructure automatically. This allows the game backend to scale with demand while keeping the game server lifecycle separate from the matchmaking runtime.

## Prerequisites

Before running the project, ensure you have:

- Node.js 18+
- npm
- Docker
- A running Docker daemon
- A configured shared secret for internal service authentication

## Quick start

### 1. Start the game server service

```bash
cd game-servers-service
cp .env.example .env
npm install
npm run build
npm run start
```

Or with Docker Compose:

```bash
cd game-servers-service
docker compose up -d --build
```

### 2. Start Nakama hooks

```bash
cd nakama-hooks
npm install
npm run build
docker compose up -d
```

## Environment configuration

The project uses environment variables for service configuration, Docker image selection, ports, cleanup intervals, and secrets. Example files are included in both service folders:

- `game-servers-service/.env.example`
- `nakama-hooks/.env.example`

## Security

This project assumes trusted internal service communication. The backend endpoints are protected by an internal auth header and should only be exposed to systems you trust.

## Use cases

This infrastructure is well suited for:

- online multiplayer games
- matchmaking-based server allocation
- dedicated game instance lifecycle automation
- WebSocket-heavy multiplayer backends

## Notes

- The service uses the Docker socket to manage game containers directly
- Port allocation is handled dynamically to avoid conflicts
- Expired or orphaned game servers are cleaned up by background maintenance
- Nakama hooks allow server creation only when matchmaker conditions are met

## License

This repository currently does not declare a public license in the project metadata. Please review the repository settings before publishing or reusing the code outside your organization.

## Suggested repository description

`TypeScript multiplayer backend for Nakama + Dockerized game server orchestration, dynamic match spawning, WebSocket routing, and lifecycle cleanup.`
