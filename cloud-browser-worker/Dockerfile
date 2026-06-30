FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production
ENV HEADLESS=true

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

EXPOSE 8787
CMD ["npm", "start"]
