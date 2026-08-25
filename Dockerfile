FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
RUN npm install

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package.json ./package.json
ENV HOME=/home/alexx78
EXPOSE 4573
CMD ["node", "dist/cli.js", "--no-open", "--lan", "--port", "4573"]
