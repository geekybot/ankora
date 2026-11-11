# Testnet keeper: relays mainnet NEAR/USD into the testnet price relay and settles due loans.
# Runtime env: ANKORA_RELAY, ANKORA_POOL, KEEPER_PRIVATE_KEY (ed25519:..., the relay owner's key; set it as a host secret).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=150s --retries=2 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "bin/keeper.ts"]
