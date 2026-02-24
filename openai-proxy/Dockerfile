FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080

USER node

CMD ["node", "index.js"]
