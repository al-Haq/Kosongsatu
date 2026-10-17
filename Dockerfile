FROM node:24-bookworm-slim
# Chinese (中文) documents need a CJK font in their PDFs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
RUN mkdir -p /app/backups && chown node:node /app/backups && chmod 700 /app/backups
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/nawlogic.sqlite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/app.mjs"]
