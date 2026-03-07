FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]
