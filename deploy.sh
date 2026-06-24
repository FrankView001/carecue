#!/bin/bash

# ==============================================================================
# CareCue 一键部署脚本 (适用于 Ubuntu/Debian, 针对 2C2G 优化)
# ==============================================================================

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}      CareCue 一键环境配置与部署脚本      ${NC}"
echo -e "${GREEN}==========================================${NC}"

# 1. 检查是否为 root 用户
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}请使用 root 权限运行此脚本 (sudo ./deploy.sh)${NC}"
  exit 1
fi

# 2. 配置 Swap 虚拟内存 (防 2G 内存 OOM)
echo -e "\n${YELLOW}>>> [1/5] 检查并配置 Swap 虚拟内存...${NC}"
if ! grep -q "swapfile" /etc/fstab; then
    echo "创建 2GB Swap 文件..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo -e "${GREEN}Swap 配置完成！${NC}"
else
    echo -e "${GREEN}Swap 已经配置过，跳过。${NC}"
fi

# 3. 安装 Docker 和 Docker Compose
echo -e "\n${YELLOW}>>> [2/5] 检查 Docker 环境...${NC}"
if ! command -v docker &> /dev/null; then
    echo "正在安装 Docker..."
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    echo -e "${GREEN}Docker 安装完成！${NC}"
else
    echo -e "${GREEN}Docker 已安装。${NC}"
fi

# 4. 检查/生成 .env 文件
echo -e "\n${YELLOW}>>> [3/5] 检查环境变量 (.env)...${NC}"
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "未发现 .env 文件，从 .env.example 复制..."
        cp .env.example .env
        
        # 自动生成强随机的 JWT_SECRET
        RANDOM_SECRET=$(openssl rand -hex 32)
        sed -i "s/JWT_SECRET=\"replace-with-a-long-random-secret\"/JWT_SECRET=\"$RANDOM_SECRET\"/" .env
        
        # 自动获取当前服务器公网 IP，并修改 CLIENT_ORIGIN
        PUBLIC_IP=$(curl -s ifconfig.me)
        if [ ! -z "$PUBLIC_IP" ]; then
             sed -i "s|CLIENT_ORIGIN=\"http://127.0.0.1:5173,http://localhost:5173\"|CLIENT_ORIGIN=\"http://$PUBLIC_IP\"|" .env
             echo "自动识别到公网 IP: $PUBLIC_IP"
        fi

        echo -e "${YELLOW}!!! 警告: 我已为你自动生成了 .env 文件，但你需要手动填入 API Key !!!${NC}"
        echo -e "请使用 ${GREEN}nano .env${NC} 修改 OPENROUTER_API_KEY 和 FIRECRAWL_API_KEY"
        echo -e "修改完成后，重新运行此脚本。"
        exit 0
    else
        echo -e "${RED}未找到 .env.example，请确保你在 CareCue 项目根目录下运行此脚本。${NC}"
        exit 1
    fi
else
    # 检查 API KEY 是否配置
    if grep -q "sk-or-v1-your-openrouter-api-key" .env; then
        echo -e "${RED}错误: .env 文件中的 OPENROUTER_API_KEY 未配置！${NC}"
        echo -e "请使用 ${GREEN}nano .env${NC} 修改，然后重新运行此脚本。"
        exit 1
    fi
    echo -e "${GREEN}.env 文件已准备就绪。${NC}"
fi

# 5. 启动 Docker 容器
echo -e "\n${YELLOW}>>> [4/5] 正在构建并启动 CareCue 容器 (可能需要 3-5 分钟)...${NC}"
docker compose down
docker compose up -d --build

# 6. 完成与提示
echo -e "\n${YELLOW}>>> [5/5] 部署完成检查...${NC}"
PUBLIC_IP=$(curl -s ifconfig.me)

echo -e "\n${GREEN}==========================================${NC}"
echo -e "🎉 ${GREEN}部署流程执行完毕！${NC}"
echo -e "🌐 ${YELLOW}请在浏览器中访问: http://$PUBLIC_IP${NC}"
echo -e ""
echo -e "📋 查看实时运行日志命令: ${GREEN}docker compose logs -f${NC}"
echo -e "🛑 停止服务命令: ${GREEN}docker compose down${NC}"
echo -e "${GREEN}==========================================${NC}"
