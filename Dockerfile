FROM node:20-alpine

WORKDIR /app

# Instala dependências do sistema necessárias para compilação se houver
RUN apk add --no-cache openssl

# Copia manifests de pacotes
COPY package*.json ./
COPY prisma ./prisma/

# Instala dependências
RUN npm install

# Gera o client do Prisma
RUN npx prisma generate

# Copia código-fonte
COPY . .

# Cria pasta de uploads
RUN mkdir -p uploads

EXPOSE 3333

ENV PORT=3333
ENV NODE_ENV=production

CMD ["node", "server.js"]
