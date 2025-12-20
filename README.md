# Antigravity2Api

本服务是一个兼容 Claude 接口、并提供 Gemini 原生接口透传的本地代理服务，支持多账号轮询、API Key 认证以及自定义代理配置。

> **推荐启动方式**：在项目根目录运行 `node src/server.js`。本项目会以当前工作目录（`process.cwd()`）定位 `.env`、`auths/`、`log/`；如果你在 `src/` 目录运行，则对应路径会变成 `src/.env`、`src/auths/`、`src/log/`。

启动后可直接访问管理界面：`http://localhost:3000/`（端口以 `AG2API_PORT` 为准，默认 3000）。

## 1. 环境准备

确保已安装 [Node.js](https://nodejs.org/) (建议版本 v18 或更高)。

## 2. 安装依赖

如果你不启用代理（`AG2API_PROXY_ENABLED=false`），无需安装任何额外依赖。

如果你启用代理，为了确保代理对 `fetch` 生效，建议安装以下依赖（按需选择）：

在项目根目录下打开终端（CMD 或 PowerShell）运行：

```bash
npm install undici
```

可选：如果你不装 `undici`，会自动降级到 `node-fetch`，此时需要安装：

```bash
npm install node-fetch https-proxy-agent
```

可选：如果你使用 SOCKS5 代理，需要安装：

```bash
npm install node-fetch socks-proxy-agent
```

> **注意**：如果在 PowerShell 中遇到“无法加载文件...npm.ps1”的错误，请尝试使用 CMD 运行，或者使用以下命令绕过策略：
> ```bash
> cmd /c npm install undici
> ```

## 3. 配置文件 (.env)

在项目根目录下创建 `.env`（建议从 `.env.example` 复制），通过环境变量配置服务。

**示例 `.env`：**

```bash
AG2API_HOST=0.0.0.0
AG2API_PORT=3000
AG2API_API_KEYS=sk-your-secret-key-1,sk-your-secret-key-2
AG2API_PROXY_ENABLED=false
AG2API_PROXY_URL=
AG2API_DEBUG=false
```

**配置项说明：**

- `AG2API_HOST`：监听地址
- `AG2API_PORT`：监听端口
- `AG2API_API_KEYS`：API Key（逗号分隔或 JSON 数组字符串；为空表示不校验）
- `AG2API_PROXY_ENABLED`：是否启用代理（true/false）
- `AG2API_PROXY_URL`：代理地址
- `AG2API_DEBUG`：是否开启 debug（true/false）

Google OAuth Client（可选覆盖）：

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

## 4. 启动服务

运行以下命令启动服务器：

```bash
node src/server.js
```

启动后打开管理界面添加/删除账号：

- 管理界面：`http://localhost:3000/`
- OAuth 添加账号：点击页面中的 “OAuth 添加账号” 按钮

如果你仍然希望用命令行方式添加账号，也可以运行：

```bash
node src/server.js --add
```

> `--add` 授权成功后会继续启动服务（同 `node src/server.js`），无需再手动重启。

## 5. Web 管理界面

管理界面提供：

- 查看已加载账号（脱敏信息）
- OAuth 添加账号（写入 `auths/*.json`）
- 删除账号（删除对应 `auths/*.json`）

如果你设置了 `AG2API_API_KEYS`，页面会要求你输入 Key 才能调用管理接口（Key 仅保存在浏览器本地）。

> OAuth 回调默认使用：`http://localhost:<port>/oauth-callback`（`<port>` 取 `AG2API_PORT`，默认 3000）。
> 若你是在远程机器访问本服务，授权完成后浏览器可能会跳转到 `localhost`，请把地址栏里的 `localhost:<port>` 改成当前服务地址再回车即可。
> 如果你不方便改地址，也可以直接复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页 “提交” 输入框中完成授权入库。

## 6. Docker 部署

推荐直接使用已发布的 GHCR 镜像：`ghcr.io/znlsl/antigravity2api:latest`（`linux/amd64` + `linux/arm64`）。

### 6.1 使用 GHCR 镜像（推荐）

1) 复制环境变量文件并修改（不要提交 `.env`）：

```bash
cp .env.example .env
```

2) 启动（拉取 GHCR 镜像）：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

> 私有仓库/私有镜像需要先登录：`docker login ghcr.io`

### 6.2 本地构建（可选）

本地构建适合你要改代码/调试 Dockerfile 的情况。

用 compose 构建并启动：

```bash
docker compose up -d --build
```

或手动 build + run：

构建镜像：

```bash
docker build -t antigravity2api:latest .
```

启动容器（使用 `.env` 传配置）：

```bash
docker run -d --name antigravity2api \
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/auths:/app/auths" \
  -v "$(pwd)/log:/app/log" \
  antigravity2api:latest
```

数据持久化：

- `./auths`（账号凭证）
- `./log`（日志）

### 6.3 GitHub Actions 自动构建 GHCR 镜像

已提供工作流：`.github/workflows/docker-ghcr.yml`，每次 push 到 `main` 会自动构建并推送：

- `ghcr.io/znlsl/antigravity2api:latest`
- 平台：`linux/amd64` + `linux/arm64`（multi-arch）

### 6.4 服务器更新镜像（升级）

如果你使用的是 GHCR 镜像部署（`docker-compose.ghcr.yml`），当仓库有新提交并且 GitHub Actions 构建完成后，在服务器执行：

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

如果你使用的是本地构建（`docker-compose.yml` 的 `build:`），更新代码后需要重新构建：

```bash
docker compose up -d --build
```

## 7. 客户端连接 (如 CherryStudio)

在客户端中添加自定义提供商（Claude）：

*   **API 地址 (Endpoint)**: `http://localhost:3000` (或 `http://<本机IP>:3000`)
    *   Claude 兼容路径: `http://localhost:3000/v1/messages`
    *   Gemini 原生路径: `http://localhost:3000/v1beta`
*   **API 密钥 (API Key)**: 填写你在 `AG2API_API_KEYS` 中配置的任意一个 Key。
    *   支持的传递方式：`Authorization: Bearer <key>` / `x-api-key` / `anthropic-api-key` / `x-goog-api-key`

## 8. 常见问题

*   **401 Unauthorized**: 检查客户端填写的 API Key 是否与 `AG2API_API_KEYS` 中的一致。
*   **Proxy 错误 / 超时**:
    *   确保已运行 `npm install` 安装依赖。
    *   检查 `AG2API_PROXY_URL` 是否正确且代理软件已开启。
    *   如果是 SOCKS5 代理，确保 `socks-proxy-agent` 已安装。

*   **OAuth 回调打不开**:
    *   授权完成后若跳到 `http://localhost:<port>/oauth-callback`，请把 `localhost:<port>` 改成当前服务地址再访问。
    *   或者复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页输入框中点击 “提交”。
