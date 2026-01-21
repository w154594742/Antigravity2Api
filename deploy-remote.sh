#!/usr/bin/env bash

# ========================================
# 🚀 Antigravity2Api 远程部署脚本
# ========================================
# 功能: 本地构建镜像 + 上传服务器 + 滚动更新
# 作者: wangqiupei
# 优势: 避免服务器 CPU 高负载，构建在本地完成
#       滚动更新策略，停机时间 < 1 秒
# ========================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ========================================
# 配置区域
# ========================================

# 服务器连接配置
REMOTE_HOST="8.137.115.72"
REMOTE_PORT="22"
REMOTE_USER="root"
REMOTE_PASS="Admin2012,."
REMOTE_PROJECT_DIR="/opt/docker_projects/Antigravity2Api"

# 容器和镜像配置
CONTAINER_NAME="antigravity2api"
IMAGE_NAME="antigravity2api"
IMAGE_TAG="latest"

# 临时文件配置
TEMP_DIR="/tmp/antigravity2api-deploy"
IMAGE_TAR="antigravity2api-image.tar.gz"

# 服务端口（从 .env 读取或使用默认值）
SERVICE_PORT="${AG2API_PORT:-3000}"

# 运行模式标志
AUTO_MODE=false
SKIP_BUILD=false
ROLLBACK_MODE=false

# 部署模式（自动检测：init 或 update）
DEPLOY_MODE=""

# 版本标签（自动从 git 获取）
VERSION_TAG=""

# ========================================
# 命令行参数解析
# ========================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        --auto)
            AUTO_MODE=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --rollback)
            ROLLBACK_MODE=true
            shift
            ;;
        --help|-h)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --auto        自动模式，跳过所有用户确认"
            echo "  --skip-build  跳过本地构建，使用已有镜像"
            echo "  --rollback    回滚到上一个版本"
            echo "  --help        显示此帮助信息"
            echo ""
            echo "功能: 本地构建镜像后上传到服务器执行滚动更新"
            echo "      - 首次部署：自动创建目录和配置文件"
            echo "      - 后续更新：滚动更新，停机时间 < 1 秒"
            echo "      - 版本标签：自动使用 git commit hash"
            echo ""
            echo "示例:"
            echo "  $0              # 交互式部署"
            echo "  $0 --auto       # 自动部署（适合 CI/CD）"
            echo "  $0 --skip-build # 跳过构建，直接上传已有镜像"
            echo "  $0 --rollback   # 回滚到上一个版本"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            echo "使用 --help 查看帮助"
            exit 1
            ;;
    esac
done

# ========================================
# 颜色和日志函数
# ========================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
    exit 1
}

log_step() {
    echo -e "${CYAN}$1${NC}"
}

# ========================================
# 工具函数
# ========================================

# 获取 git 版本信息
get_version_tag() {
    local git_hash=""
    local git_dirty=""

    # 获取 git commit hash（短格式）
    if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
        git_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
        # 检查是否有未提交的更改
        if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
            git_dirty="-dirty"
        fi
    else
        git_hash="nogit"
    fi

    VERSION_TAG="${git_hash}${git_dirty}"
    echo "$VERSION_TAG"
}

# 检查必要的命令是否存在
check_requirements() {
    local missing=()

    command -v docker >/dev/null 2>&1 || missing+=("docker")
    command -v sshpass >/dev/null 2>&1 || missing+=("sshpass")

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "缺少必要的命令: ${missing[*]}\n请先安装: brew install ${missing[*]}"
    fi
}

# 远程执行命令（带密码）
remote_exec() {
    sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
        -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "$@"
}

# 远程上传文件
remote_scp() {
    local src="$1"
    local dst="$2"
    sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no \
        -P "$REMOTE_PORT" "$src" "$REMOTE_USER@$REMOTE_HOST:$dst"
}

# 检查远程容器是否运行
is_container_running() {
    remote_exec "docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^${CONTAINER_NAME}$'"
}

# 等待容器就绪（通过进程检查）
wait_container_ready() {
    local container=$1
    local max_wait=${2:-60}
    local wait_count=0

    echo "⏳ 等待容器 $container 就绪..."

    while [[ $wait_count -lt $max_wait ]]; do
        # 检查容器是否在运行
        local status
        status=$(remote_exec "docker inspect --format='{{.State.Status}}' '$container' 2>/dev/null || echo 'none'") || true

        if [[ "$status" == "running" ]]; then
            # 额外等待 2 秒确保服务完全启动
            sleep 2
            log_info "容器 $container 已就绪！"
            return 0
        fi

        echo "  状态: $status (等待 ${wait_count}s / ${max_wait}s)"
        sleep 2
        wait_count=$((wait_count + 2))
    done

    log_error "容器 $container 启动超时！"
}

# 用户确认（自动模式跳过）
confirm_action() {
    local prompt="$1"
    if [[ "$AUTO_MODE" == "true" ]]; then
        return 0
    fi
    echo ""
    read -r -p "$(echo -e ${YELLOW}"${prompt} (Y/n): "${NC})" answer
    if [[ "$answer" =~ ^[Nn]$ ]]; then
        log_info "用户取消操作"
        exit 0
    fi
}

# ========================================
# 步骤1: 检测部署模式
# ========================================

detect_deploy_mode() {
    echo ""
    echo "======================================"
    log_step "🔍 步骤1: 检测部署模式"
    echo "======================================"

    log_info "连接服务器检测环境..."

    # 检测远程目录是否存在
    if remote_exec "[ -d '$REMOTE_PROJECT_DIR' ] && [ -f '$REMOTE_PROJECT_DIR/.env' ]"; then
        DEPLOY_MODE="update"
        log_info "检测到已有部署，将执行【滚动更新】"
    else
        DEPLOY_MODE="init"
        log_warn "未检测到已有部署，将执行【首次部署】"
    fi

    # 检测容器状态
    echo ""
    echo "📊 服务器状态："
    if is_container_running; then
        echo "   容器状态: 运行中 ✅"
    else
        echo "   容器状态: 未运行 ⭕"
    fi

    # 用户确认
    if [[ "$DEPLOY_MODE" == "init" ]]; then
        confirm_action "首次部署将创建目录和配置文件，是否继续？"
    else
        confirm_action "是否继续滚动更新？"
    fi
}

# ========================================
# 步骤2: 本地构建镜像
# ========================================

build_local_image() {
    # 跳过构建模式
    if [[ "$SKIP_BUILD" == "true" ]]; then
        echo ""
        echo "======================================"
        log_step "🔨 步骤2: 跳过本地构建（使用已有镜像）"
        echo "======================================"

        # 检查镜像是否存在
        if ! docker image inspect "${IMAGE_NAME}:${IMAGE_TAG}" >/dev/null 2>&1; then
            log_error "镜像 ${IMAGE_NAME}:${IMAGE_TAG} 不存在！请先构建或移除 --skip-build 参数"
        fi

        log_info "使用已有镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
        return 0
    fi

    echo ""
    echo "======================================"
    log_step "🔨 步骤2: 本地构建镜像"
    echo "======================================"

    # 获取版本标签
    local version_tag
    version_tag=$(get_version_tag)

    # 启用 BuildKit
    export DOCKER_BUILDKIT=1
    export BUILDKIT_PROGRESS=plain
    local cache_bust
    cache_bust=$(date +%s%N)

    log_info "开始本地构建镜像..."
    log_info "镜像标签: ${IMAGE_NAME}:${IMAGE_TAG}"
    log_info "版本标签: ${IMAGE_NAME}:${version_tag}"
    log_info "目标平台: linux/amd64 (服务器架构)"
    echo ""

    # 构建镜像（指定目标平台为 linux/amd64，适配服务器架构）
    (cd "$PROJECT_ROOT" && docker build \
        --platform linux/amd64 \
        --build-arg CACHE_BUST="${cache_bust}" \
        -t "${IMAGE_NAME}:${IMAGE_TAG}" \
        -t "${IMAGE_NAME}:${version_tag}" \
        -f Dockerfile .) || log_error "镜像构建失败！"

    log_info "本地镜像构建完成！"

    # 显示镜像信息
    echo ""
    echo "📦 镜像信息："
    docker images | grep -E "REPOSITORY|${IMAGE_NAME}" | head -5
}

# ========================================
# 步骤3: 导出并压缩镜像
# ========================================

export_and_compress() {
    echo ""
    echo "======================================"
    log_step "📦 步骤3: 导出并压缩镜像"
    echo "======================================"

    # 创建临时目录
    mkdir -p "$TEMP_DIR"

    local image_path="${TEMP_DIR}/${IMAGE_TAR}"

    log_info "导出镜像并压缩..."
    log_info "目标文件: $image_path"
    echo ""

    # 导出并压缩（使用 pv 显示进度，如果可用）
    if command -v pv >/dev/null 2>&1; then
        docker save "${IMAGE_NAME}:${IMAGE_TAG}" | pv | gzip > "$image_path"
    else
        echo "  正在导出和压缩，请稍候..."
        docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "$image_path"
    fi

    # 显示文件大小
    local file_size
    file_size=$(ls -lh "$image_path" | awk '{print $5}')
    log_info "镜像压缩完成！文件大小: $file_size"
}

# ========================================
# 步骤4: 上传镜像到服务器
# ========================================

upload_to_server() {
    echo ""
    echo "======================================"
    log_step "🚀 步骤4: 上传镜像到服务器"
    echo "======================================"

    local image_path="${TEMP_DIR}/${IMAGE_TAR}"
    local remote_path="/tmp/${IMAGE_TAR}"

    log_info "开始上传镜像到服务器..."
    log_info "本地文件: $image_path"
    log_info "远程路径: $remote_path"
    echo ""

    # 计算预估时间
    local file_size_bytes
    file_size_bytes=$(stat -f%z "$image_path" 2>/dev/null || stat -c%s "$image_path" 2>/dev/null)
    local estimated_seconds=$((file_size_bytes / 625000))  # 5Mbps ≈ 625KB/s
    log_info "预估上传时间: 约 ${estimated_seconds} 秒 (5Mbps 带宽)"
    echo ""

    # 使用 scp 上传（带进度显示）
    remote_scp "$image_path" "$remote_path" || log_error "镜像上传失败！"

    log_info "镜像上传完成！"
}

# ========================================
# 步骤5: 服务器加载镜像
# ========================================

load_remote_image() {
    echo ""
    echo "======================================"
    log_step "📥 步骤5: 服务器加载镜像"
    echo "======================================"

    local remote_path="/tmp/${IMAGE_TAR}"

    log_info "在服务器上加载镜像..."
    echo ""

    # 加载镜像
    remote_exec "gunzip -c '$remote_path' | docker load" || \
        log_error "镜像加载失败！"

    log_info "镜像加载完成！"

    # 显示服务器上的镜像
    echo ""
    echo "📦 服务器镜像列表："
    remote_exec "docker images | grep -E 'REPOSITORY|${IMAGE_NAME}' | head -5"
}

# ========================================
# 步骤6: 首次部署初始化
# ========================================

init_first_deploy() {
    if [[ "$DEPLOY_MODE" != "init" ]]; then
        return 0
    fi

    echo ""
    echo "======================================"
    log_step "🏗️  步骤6: 首次部署初始化"
    echo "======================================"

    # 创建目录结构
    log_info "创建目录结构..."
    remote_exec "mkdir -p '$REMOTE_PROJECT_DIR'/{auths,log}"

    # 上传 docker-compose.yml
    log_info "上传 docker-compose.yml..."
    remote_scp "${PROJECT_ROOT}/docker-compose.yml" "${REMOTE_PROJECT_DIR}/docker-compose.yml"

    # 上传 .env.example
    log_info "上传 .env.example..."
    remote_scp "${PROJECT_ROOT}/.env.example" "${REMOTE_PROJECT_DIR}/.env.example"

    # 检查是否需要创建 .env
    if ! remote_exec "[ -f '$REMOTE_PROJECT_DIR/.env' ]"; then
        log_warn "首次部署需要配置 .env 文件"
        echo ""
        echo "请选择操作："
        echo "  1. 复制本地 .env 到服务器（推荐）"
        echo "  2. 使用 .env.example 作为模板（需要手动编辑）"
        echo ""

        if [[ "$AUTO_MODE" == "true" ]]; then
            # 自动模式：复制本地 .env
            if [[ -f "${PROJECT_ROOT}/.env" ]]; then
                log_info "自动模式：复制本地 .env 到服务器"
                remote_scp "${PROJECT_ROOT}/.env" "${REMOTE_PROJECT_DIR}/.env"
            else
                log_error "自动模式下未找到本地 .env 文件，请先创建"
            fi
        else
            read -r -p "请选择 (1/2): " choice
            case "$choice" in
                1)
                    if [[ -f "${PROJECT_ROOT}/.env" ]]; then
                        remote_scp "${PROJECT_ROOT}/.env" "${REMOTE_PROJECT_DIR}/.env"
                        log_info ".env 文件已上传"
                    else
                        log_error "本地 .env 文件不存在，请先创建"
                    fi
                    ;;
                2)
                    remote_exec "cp '$REMOTE_PROJECT_DIR/.env.example' '$REMOTE_PROJECT_DIR/.env'"
                    log_warn ".env 已从模板创建，请稍后登录服务器编辑配置"
                    echo "  编辑命令: ssh root@${REMOTE_HOST} 'vim ${REMOTE_PROJECT_DIR}/.env'"
                    ;;
                *)
                    log_error "无效选择"
                    ;;
            esac
        fi
    fi

    log_info "首次部署初始化完成！"
}

# ========================================
# 步骤7: 滚动更新容器
# ========================================

rolling_update() {
    echo ""
    echo "======================================"
    log_step "🔄 步骤7: 滚动更新容器"
    echo "======================================"

    # 进入项目目录执行 docker compose
    log_info "执行滚动更新（使用 docker compose）..."

    # 检测服务器上的 docker compose 命令格式
    local compose_cmd
    if remote_exec "command -v docker-compose >/dev/null 2>&1"; then
        compose_cmd="docker-compose"
    else
        compose_cmd="docker compose"
    fi
    log_info "使用命令: $compose_cmd"

    # 使用 docker compose up -d 进行滚动更新
    # --force-recreate 确保使用新镜像
    # 这个命令会先启动新容器，再停止旧容器，停机时间最短
    remote_exec "cd '$REMOTE_PROJECT_DIR' && ${compose_cmd} up -d --force-recreate" || \
        log_error "容器更新失败！"

    # 等待容器就绪
    wait_container_ready "$CONTAINER_NAME" 60

    log_info "滚动更新完成！"
}

# ========================================
# 步骤8: 验证服务
# ========================================

verify_service() {
    echo ""
    echo "======================================"
    log_step "🔍 步骤8: 验证服务"
    echo "======================================"

    # 获取容器状态
    log_info "检查容器状态..."
    remote_exec "docker ps | grep -E 'CONTAINER|${CONTAINER_NAME}'"

    # 显示容器日志（最后10行）
    echo ""
    echo "📋 容器日志（最后10行）："
    echo "--------------------------------------"
    remote_exec "docker logs --tail 10 '$CONTAINER_NAME' 2>&1" || true
    echo "--------------------------------------"

    # 测试服务连通性
    log_info "测试服务连通性..."

    # 读取远程 .env 获取端口
    local port
    port=$(remote_exec "grep '^AG2API_PORT=' '$REMOTE_PROJECT_DIR/.env' 2>/dev/null | cut -d'=' -f2" || echo "3000")
    port=${port:-3000}

    # 尝试访问服务
    if remote_exec "curl -sf --max-time 5 http://localhost:${port}/ >/dev/null 2>&1"; then
        log_info "服务响应正常！端口: ${port}"
    else
        log_warn "服务可能仍在启动中，请稍后检查"
        echo "  测试命令: curl http://${REMOTE_HOST}:${port}/"
    fi
}

# ========================================
# 步骤9: 清理
# ========================================

cleanup() {
    echo ""
    echo "======================================"
    log_step "🧹 步骤9: 清理临时文件"
    echo "======================================"

    # 清理服务器临时文件
    log_info "清理服务器临时文件..."
    remote_exec "rm -f /tmp/${IMAGE_TAR}"

    # 清理服务器悬空镜像
    log_info "清理服务器悬空镜像..."
    remote_exec "docker image prune -f 2>/dev/null || true"

    # 清理本地临时文件
    log_info "清理本地临时文件..."
    rm -rf "$TEMP_DIR"

    log_info "清理完成！"
}

# ========================================
# 显示部署结果
# ========================================

show_result() {
    echo ""
    echo "========================================="
    log_info "🎉 部署完成！"
    echo "========================================="
    echo ""
    echo "📌 部署信息："
    echo "   服务器: ${REMOTE_HOST}"
    echo "   项目目录: ${REMOTE_PROJECT_DIR}"
    echo "   容器名称: ${CONTAINER_NAME}"
    echo ""
    echo "🔧 常用命令："
    echo "   查看日志: ssh root@${REMOTE_HOST} 'docker logs -f ${CONTAINER_NAME}'"
    echo "   重启服务: ssh root@${REMOTE_HOST} 'cd ${REMOTE_PROJECT_DIR} && docker compose restart'"
    echo "   停止服务: ssh root@${REMOTE_HOST} 'cd ${REMOTE_PROJECT_DIR} && docker compose down'"
    echo "   回滚版本: $0 --rollback"
    echo ""
}

# ========================================
# 回滚功能
# ========================================

do_rollback() {
    echo ""
    echo "========================================="
    echo "  🔄 Antigravity2Api 版本回滚"
    echo "========================================="
    echo ""

    # 检查必要命令
    check_requirements

    log_info "连接服务器获取可用版本..."

    # 获取服务器上的镜像列表
    echo ""
    echo "📦 服务器上可用的镜像版本："
    echo "--------------------------------------"
    local images
    images=$(remote_exec "docker images ${IMAGE_NAME} --format '{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}' | head -10")

    if [[ -z "$images" ]]; then
        log_error "服务器上没有找到 ${IMAGE_NAME} 镜像"
    fi

    echo "$images"
    echo "--------------------------------------"
    echo ""

    # 获取当前运行的版本
    local current_image
    current_image=$(remote_exec "docker inspect ${CONTAINER_NAME} --format '{{.Config.Image}}' 2>/dev/null" || echo "unknown")
    log_info "当前运行版本: ${current_image}"

    # 获取可用的标签列表
    local tags
    tags=$(remote_exec "docker images ${IMAGE_NAME} --format '{{.Tag}}' | grep -v '<none>'")

    if [[ -z "$tags" ]]; then
        log_error "没有可用的回滚版本"
    fi

    # 选择回滚版本
    echo ""
    echo "请输入要回滚的版本标签（如 latest 或 git commit hash）："

    if [[ "$AUTO_MODE" == "true" ]]; then
        # 自动模式：回滚到上一个版本（非 latest 的第一个）
        local rollback_tag
        rollback_tag=$(echo "$tags" | grep -v "^latest$" | head -1)
        if [[ -z "$rollback_tag" ]]; then
            log_error "自动模式下没有找到可回滚的版本"
        fi
        log_info "自动模式：回滚到版本 ${rollback_tag}"
    else
        read -r -p "版本标签: " rollback_tag
        if [[ -z "$rollback_tag" ]]; then
            log_error "未输入版本标签"
        fi
    fi

    # 确认回滚
    confirm_action "确认将服务回滚到 ${IMAGE_NAME}:${rollback_tag}？"

    # 执行回滚
    log_info "开始回滚..."

    # 检测服务器上的 docker compose 命令格式
    local compose_cmd
    if remote_exec "command -v docker-compose >/dev/null 2>&1"; then
        compose_cmd="docker-compose"
    else
        compose_cmd="docker compose"
    fi

    # 修改 docker-compose.yml 中的镜像标签（临时）并重新部署
    # 由于 docker-compose.yml 使用 build 而非固定镜像，我们直接用 docker run
    log_info "停止当前容器..."
    remote_exec "docker stop ${CONTAINER_NAME} 2>/dev/null || true"
    remote_exec "docker rm ${CONTAINER_NAME} 2>/dev/null || true"

    log_info "使用版本 ${rollback_tag} 启动容器..."

    # 读取远程 .env 获取端口
    local port
    port=$(remote_exec "grep '^AG2API_PORT=' '$REMOTE_PROJECT_DIR/.env' 2>/dev/null | cut -d'=' -f2" || echo "3000")
    port=${port:-3000}

    # 启动新容器
    remote_exec "cd '$REMOTE_PROJECT_DIR' && docker run -d \
        --name ${CONTAINER_NAME} \
        --env-file .env \
        -p ${port}:${port} \
        -v ./auths:/app/auths \
        -v ./log:/app/log \
        --restart unless-stopped \
        ${IMAGE_NAME}:${rollback_tag}" || log_error "回滚失败！"

    # 等待容器就绪
    wait_container_ready "$CONTAINER_NAME" 60

    # 验证服务
    log_info "验证服务..."
    if remote_exec "curl -sf --max-time 5 http://localhost:${port}/ >/dev/null 2>&1"; then
        log_info "服务响应正常！"
    else
        log_warn "服务可能仍在启动中，请稍后检查"
    fi

    echo ""
    echo "========================================="
    log_info "🎉 回滚完成！"
    echo "========================================="
    echo ""
    echo "📌 回滚信息："
    echo "   回滚版本: ${IMAGE_NAME}:${rollback_tag}"
    echo "   容器名称: ${CONTAINER_NAME}"
    echo ""
}

# ========================================
# 主流程
# ========================================

main() {
    echo ""
    echo "========================================="
    echo "  🚀 Antigravity2Api 远程部署工具"
    echo "========================================="
    echo ""
    echo "功能: 本地构建 → 上传服务器 → 滚动更新"
    echo "优势: 停机时间 < 1 秒"
    echo ""

    # 检查必要命令
    check_requirements

    # 检测部署模式
    detect_deploy_mode

    # 本地构建
    build_local_image

    # 导出压缩
    export_and_compress

    # 上传服务器
    upload_to_server

    # 加载镜像
    load_remote_image

    # 首次部署初始化（如果需要）
    init_first_deploy

    # 滚动更新
    rolling_update

    # 验证服务
    verify_service

    # 清理
    cleanup

    # 显示结果
    show_result
}

# 捕获错误
trap 'echo ""; log_error "部署过程中发生错误"' ERR

# 根据模式运行
if [[ "$ROLLBACK_MODE" == "true" ]]; then
    do_rollback
else
    main
fi
