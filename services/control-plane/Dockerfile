FROM node:22-alpine
WORKDIR /app
# 仅复制清单先装依赖，利用构建缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
# 生产默认值可在 compose 环境变量覆盖
ENV DEYI_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
