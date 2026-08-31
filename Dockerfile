# syntax=docker/dockerfile:1

FROM node:20-slim

WORKDIR /app

# Install production dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy application source and the static frontend
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
