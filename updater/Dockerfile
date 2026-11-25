# The updater helper (see server.mjs). Docker's own CLI (with compose and buildx) plus git and Node.
FROM docker:27-cli
RUN apk add --no-cache git nodejs
WORKDIR /app
COPY server.mjs .
EXPOSE 8080
CMD ["node", "server.mjs"]
