FROM node:20-alpine AS build
WORKDIR /app

COPY package.json tsconfig.json rollup.config.mjs ./
COPY src ./src

RUN npm install --legacy-peer-deps && npm run build

FROM heroiclabs/nakama:3.22.0

COPY --from=build /app/dist /nakama/data/modules

LABEL org.opencontainers.image.title="custom-nakama-with-hooks"
LABEL org.opencontainers.image.description="Nakama image containing Game Servers runtime hooks"
