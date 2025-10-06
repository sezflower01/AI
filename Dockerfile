FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends stockfish ca-certificates && rm -rf /var/lib/apt/lists/*
# NEW: put stockfish on PATH
RUN ln -s /usr/games/stockfish /usr/local/bin/stockfish

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
