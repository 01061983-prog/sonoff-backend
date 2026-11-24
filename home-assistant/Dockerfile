FROM node:24-alpine
WORKDIR /app
COPY protocol.cjs ./protocol.cjs
COPY agent ./agent
ENV NODE_ENV=production
USER root
CMD ["node", "/app/agent/index.cjs"]
