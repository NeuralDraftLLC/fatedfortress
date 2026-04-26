FROM node:20-alpine
# Perplexity: sharp requires libvips — install via apk before npm install
RUN apk add --no-cache vips-dev
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts && npm rebuild sharp
COPY . .
CMD ["node", "index.js"]