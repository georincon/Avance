FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY server.js app.js index.html styles.css recursos.html recursos.js recursos.css ./
EXPOSE 4173
CMD ["node", "server.js"]
