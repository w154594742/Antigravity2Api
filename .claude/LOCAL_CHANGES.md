# 本地特性改动清单

> 本文档记录 dev 分支相对于上游 main 的所有本地特性改动。
> 供 `/sync-upstream` skill 在合并上游代码时参考，确保本地改动不被破坏。
>
> **最后更新**：2025-01-26

---

## 一、改动分类概览

| 分类 | 文件数 | 风险等级 | 说明 |
|------|--------|----------|------|
| 核心 API 修复 | 4 | 🔴 高 | Claude/Gemini 协议转换，上游可能有同位置改动 |
| UI 增强 | 6 | 🟡 中 | 账号额度显示功能，上游可能扩展 UI |
| 部署工具 | 1 | 🟢 低 | 新增文件，无冲突风险 |
| 开发文档 | 2 | 🟢 低 | 新增文件，无冲突风险 |

---

## 二、核心 API 修复（高风险）

### 2.1 ClaudeRequestIn.js

**文件路径**：`src/transform/claude/ClaudeRequestIn.js`

**提交记录**：
- `3b90ddc` - 修复 Gemini 目标模型 functionCall 缺少 thoughtSignature
- `9b50d32` - 优化系统提示词策略（追加而非替换）+ 中文响应指令

**关键改动位置**：

| 行号范围 | 功能描述 |
|----------|----------|
| 15 | 引入 ThoughtSignatureUtils 模块 |
| 134-160 | 系统提示词追加逻辑（原为替换） |
| 303-308 | MCP XML tool_use 的 thoughtSignature sentinel 处理 |
| 348-357 | 常规 functionCall 的 thoughtSignature sentinel 处理 |

**合并策略**：
- ⚠️ 如果上游修改了系统提示词处理逻辑（约 134-160 行），需手动合并
- ⚠️ 如果上游修改了 thoughtSignature 处理，需确保 sentinel 值逻辑保留
- 关键代码标记：`SKIP_SIGNATURE_SENTINEL = "skip_thought_signature_validator"`

---

### 2.2 ThoughtSignatureUtils.js（新增文件）

**文件路径**：`src/transform/claude/ThoughtSignatureUtils.js`

**提交记录**：
- `9b50d32` - 新增签名前缀处理工具

**功能**：
- `normalizeThoughtSignature()` - 去除 Claude 客户端添加的 `claude#` 签名前缀
- Gemini API 期望纯 Base64 编码签名

**合并策略**：
- 🟢 新增文件，通常无冲突
- ⚠️ 如果上游也新增同名文件，需对比功能后合并

---

### 2.3 GeminiTransformer.js

**文件路径**：`src/transform/gemini/GeminiTransformer.js`

**提交记录**：
- `9b50d32` - 系统提示词追加逻辑 + 中文响应指令

**关键改动位置**：

| 行号范围 | 功能描述 |
|----------|----------|
| 256-281 | 系统提示词追加逻辑（原为替换） |

**合并策略**：
- ⚠️ 与 ClaudeRequestIn.js 改动同步，确保两边逻辑一致
- 关键代码：`languageInstruction = "Always respond in Chinese-simplified..."`

---

### 2.4 claudeApi.js

**文件路径**：`src/api/claudeApi.js`

**提交记录**：
- `eb2b554` - 修复 Gemini → Claude 切换时 Invalid signature 错误

**关键改动位置**：

| 行号范围 | 功能描述 |
|----------|----------|
| 新增约 40 行 | MCP 模型切换时的签名处理逻辑 |

**合并策略**：
- ⚠️ 如果上游修改了 MCP 切换逻辑，需确保签名处理保留

---

## 三、UI 增强（中等风险）

### 3.1 账号额度内联显示功能

**提交记录**：
- `73b4663` - feat(ui): 添加账号列表额度内联显示和排序功能

**涉及文件**：

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/admin/accounts.js` | 新增 | 账号管理 API 端点 |
| `src/admin/routes.js` | 修改 | 注册新路由 |
| `src/server.js` | 修改 | 引入 accounts 路由 |
| `src/ui/app.js` | 修改 | 前端额度显示逻辑 |
| `src/ui/index.html` | 修改 | UI 结构调整 |
| `src/ui/style.css` | 修改 | 额度显示样式 |

**合并策略**：
- ⚠️ `src/ui/app.js` 改动较大（+315 行），上游 UI 更新时需仔细对比
- ⚠️ `src/admin/routes.js` 如果上游新增路由可能冲突
- 🟢 `src/admin/accounts.js` 为新增文件，风险较低

---

## 四、部署工具（低风险）

### 4.1 远程部署脚本

**文件路径**：`deploy-remote.sh`

**提交记录**：
- `316ed24` - feat(deploy): 添加远程部署脚本支持滚动更新

**功能**：
- Docker 容器滚动更新
- 多服务部署支持

**合并策略**：
- 🟢 新增文件，无冲突风险
- 如果上游也新增部署脚本，对比后选择保留

---

## 五、开发文档（低风险）

### 5.1 sync-upstream skill

**文件路径**：`.claude/commands/sync-upstream.md`

**提交记录**：
- `f584c25` - 添加 sync-upstream skill
- `e114209` - 增强自动化流程

**合并策略**：
- 🟢 本地专用 skill，上游通常不会有同名文件

### 5.2 .gitignore

**改动**：添加本地开发忽略规则

**合并策略**：
- 🟢 追加式改动，git 自动合并

---

## 六、合并保护策略

### 6.1 合并前检查

执行 `/sync-upstream` 时，在合并前应：

1. **对比高风险文件**：
   ```bash
   git diff main..upstream/main -- src/transform/claude/ClaudeRequestIn.js
   git diff main..upstream/main -- src/transform/gemini/GeminiTransformer.js
   git diff main..upstream/main -- src/api/claudeApi.js
   ```

2. **检查上游是否修改了关键位置**：
   - 系统提示词处理逻辑
   - thoughtSignature 相关代码
   - MCP 切换逻辑

### 6.2 冲突解决原则

| 冲突类型 | 解决策略 |
|----------|----------|
| 系统提示词逻辑 | 保留本地"追加"策略，合并上游新功能 |
| thoughtSignature 处理 | 保留 sentinel 值逻辑，这是关键修复 |
| UI 功能 | 保留本地额度显示功能，合并上游 UI 改进 |
| 新增文件冲突 | 对比功能后合并，或重命名保留两者 |

### 6.3 合并后验证

```bash
# 语法检查
node -c src/transform/claude/ClaudeRequestIn.js
node -c src/transform/gemini/GeminiTransformer.js
node -c src/api/claudeApi.js

# 功能验证
# 1. 使用 Claude CLI 调用 gemini-3-pro-high，确认工具调用正常
# 2. 确认模型使用中文响应
# 3. 确认 UI 额度显示功能正常
```

---

## 七、维护说明

- 每次向 dev 分支提交新特性后，应更新本文档
- 建议在提交信息中标注 `[LOCAL]` 前缀便于识别
- 定期清理已合入上游的改动记录
