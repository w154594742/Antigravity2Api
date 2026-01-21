# Sync Upstream - 同步上游仓库更新

从上游仓库拉取最新代码，同步到本地 main 分支，然后合并到当前开发分支。
支持自动 stash 管理、代码完整性检查、push 分歧处理。

## 使用方法

```bash
/sync-upstream [upstream_url] [dev_branch]
```

## 参数

- `upstream_url`（可选）：上游仓库地址，默认 `https://github.com/znlsl/Antigravity2Api.git`
- `dev_branch`（可选）：开发分支名称，默认 `dev`

## 执行流程

### 阶段一：环境检查

#### 1.1 检查远程配置
```bash
git remote -v
git branch -a
```
确认 upstream 远程是否已配置，查看当前分支状态。

#### 1.2 配置上游远程（如不存在）
```bash
git remote add upstream <upstream_url>
```

#### 1.3 拉取上游最新代码
```bash
git fetch upstream
```

#### 1.4 分析差异
```bash
git log main..upstream/main --oneline      # 上游领先的提交
git log main..dev --oneline                 # dev 的特性提交
git rev-parse main upstream/main            # 对比 HEAD
```
显示分支关系，**请求用户确认是否继续**。

---

### 阶段二：智能 Stash 管理

#### 2.1 检测工作区状态
```bash
git status
```

#### 2.2 自动暂存（如有未提交更改）
```bash
git stash push -u -m "sync-upstream 临时暂存"
```
- `-u` 参数包含 untracked 文件
- 记录 stash 状态，流程结束后恢复

---

### 阶段三：同步 main 分支

#### 3.1 切换并拉取
```bash
git checkout main
git pull upstream main
```

#### 3.2 推送 main（可选）
```bash
git push origin main
```
如果用户需要同步 origin/main。

---

### 阶段四：合并到开发分支

#### 4.1 切换并合并
```bash
git checkout <dev_branch>
git merge main
```
使用 merge 策略保留完整历史，dev 分支的特性提交会被保留。

#### 4.2 冲突处理（如有）
如果合并时出现冲突：
1. 列出所有冲突文件
2. 逐个分析冲突内容和上下文
3. 说明冲突原因（上游改了什么 vs 本地改了什么）
4. 给出解决建议
5. **等待用户决策**后再执行解决

---

### 阶段五：恢复 Stash

#### 5.1 恢复暂存内容
```bash
git stash pop
```

#### 5.2 处理 stash 冲突（如有）
如果 stash pop 失败（文件已存在等）：
- 检查冲突原因
- 必要时 `git stash drop` 丢弃已过时的暂存
- 保留工作区当前状态

---

### 阶段六：代码完整性检查

#### 6.1 冲突标记检查
```bash
grep -rn "<<<<<<\|======\|>>>>>>" src/ --include="*.js"
```
确保无未解决的合并冲突标记。

#### 6.2 语法检查
```bash
node -c <file.js>
```
对合并涉及的关键 JS 文件进行语法验证。

#### 6.3 Review 报告
输出检查结果，**请求用户确认是否 push**。

---

### 阶段七：推送开发分支

#### 7.1 推送
```bash
git push origin <dev_branch>
```

#### 7.2 处理 Push 分歧（如有）
如果 push 被拒绝（远程有新提交）：
```bash
git fetch origin <dev_branch>
git log <dev_branch>..origin/<dev_branch> --oneline  # 查看远程领先的提交
git pull origin <dev_branch> --no-rebase --no-edit   # 合并远程更改
git push origin <dev_branch>                          # 再次推送
```
- 需要先 stash 工作区更改
- 合并后恢复 stash

---

### 阶段八：完成报告

- 显示最终提交历史 `git log --oneline -5`
- 总结合入的提交数量
- 确认所有分支已推送
- 显示工作区最终状态

## 交互确认点

| 确认点 | 时机 | 说明 |
|--------|------|------|
| ① | 差异分析后 | 确认是否继续同步 |
| ② | 工作区有更改时 | 确认 stash 方式（自动/手动/取消） |
| ③ | 合并冲突时 | 用户决定解决策略 |
| ④ | Review 完成后 | 确认是否 push |

## 注意事项

- 使用 Merge 策略而非 Rebase，保留完整历史
- dev 分支的特性提交会被完整保留
- 冲突解决策略由用户决定，不自动选择
- 自动处理 stash 和 push 分歧，减少手动操作

## 示例

```bash
# 使用默认配置
/sync-upstream

# 指定上游仓库
/sync-upstream https://github.com/other/repo.git

# 指定上游仓库和开发分支
/sync-upstream https://github.com/other/repo.git feature-branch
```
