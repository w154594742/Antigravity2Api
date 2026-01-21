# Sync Upstream - 同步上游仓库更新

从上游仓库拉取最新代码，同步到本地 main 分支，然后合并到当前开发分支。

## 使用方法

```bash
/sync-upstream [upstream_url] [dev_branch]
```

## 参数

- `upstream_url`（可选）：上游仓库地址，默认 `https://github.com/znlsl/Antigravity2Api.git`
- `dev_branch`（可选）：开发分支名称，默认 `dev`

## 执行流程

### 1. 前置检查
- 确认当前工作区干净（无未提交更改）
- 如有未提交更改，提示用户先 stash 或 commit

### 2. 配置上游远程（如不存在）
```bash
git remote add upstream <upstream_url>
```

### 3. 拉取上游最新代码
```bash
git fetch upstream
```

### 4. 查看差异
```bash
git log main..upstream/main --oneline
```
显示上游有多少新提交，让用户了解即将合入的内容。

### 5. 同步 main 分支
```bash
git checkout main
git merge upstream/main
git push origin main
```

### 6. 合并到开发分支
```bash
git checkout <dev_branch>
git merge main
```

### 7. 冲突处理（如有）
如果合并时出现冲突：
1. 列出所有冲突文件
2. 逐个分析冲突内容和上下文
3. 说明冲突原因（上游改了什么 vs 本地改了什么）
4. 给出解决建议
5. **等待用户决策**后再执行解决

### 8. 推送开发分支
```bash
git push origin <dev_branch>
```

### 9. 完成报告
- 显示合并提交历史图
- 总结合入的提交数量
- 确认所有分支已推送

## 注意事项

- 执行前务必确保工作区干净
- 冲突解决策略由用户决定，不自动选择
- 使用 Merge 策略而非 Rebase，保留完整历史
- 如果 main 分支本身有本地提交（非来自 upstream），会产生合并提交

## 示例

```bash
# 使用默认配置
/sync-upstream

# 指定上游仓库
/sync-upstream https://github.com/other/repo.git

# 指定上游仓库和开发分支
/sync-upstream https://github.com/other/repo.git feature-branch
```
