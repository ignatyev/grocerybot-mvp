FROM node:22-alpine
WORKDIR /app
COPY package.json server.js optimizer.js adapters.js store-registry.js provider-connectors.js native-adapters.js ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
