#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# 🚀 Quick Setup - IPTV Player no Raspberry Pi
# ═══════════════════════════════════════════════════════════════════════════════
# Um único script que faz tudo!
# Uso: curl -fsSL URL_DO_SCRIPT | sudo bash -s -- YOUR_GITHUB_REPO

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

GITHUB_REPO=${1:-""}

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║          🚀 IPTV Player - Quick Setup para Raspberry Pi                   ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""

# Verificar root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Executa como root: sudo $0${NC}"
    exit 1
fi

# Verificar argumento
if [ -z "$GITHUB_REPO" ]; then
    echo -e "${YELLOW}Uso: sudo $0 username/repo${NC}"
    echo "Exemplo: sudo $0 joao/iptv-player"
    echo ""
    read -p "Qual é o repositório GitHub? (formato: username/repo): " GITHUB_REPO
fi

echo -e "${CYAN}📋 Configuração:${NC}"
echo "   Repository: $GITHUB_REPO"
echo "   Branch: deploy"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[1/8] 📦 Atualizando sistema...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
apt update && apt upgrade -y

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[2/8] 📦 Instalando dependências...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
apt install -y curl git nginx rsync ufw jq libicu-dev

# Node.js
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# PM2
npm install -g pm2

echo "   Node: $(node --version)"
echo "   NPM: $(npm --version)"

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[3/8] 👤 Criando utilizadores...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
# Utilizador da aplicação
if ! id "iptv" &>/dev/null; then
    useradd -m -s /bin/bash iptv
fi

# Utilizador do runner
if ! id "github-runner" &>/dev/null; then
    useradd -m -s /bin/bash github-runner
    usermod -aG iptv github-runner
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[4/8] 📁 Criando diretórios...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
APP_DIR="/opt/iptv-player"
RUNNER_DIR="/opt/github-runner"

mkdir -p $APP_DIR/{backend,frontend,logs,data}
mkdir -p $RUNNER_DIR

chown -R iptv:iptv $APP_DIR
chown -R github-runner:github-runner $RUNNER_DIR

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[5/8] 🌐 Configurando Nginx...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
cat > /etc/nginx/sites-available/iptv-player << 'NGINX'
server {
    listen 80;
    server_name _;
    
    location / {
        root /opt/iptv-player/frontend;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
    
    location /api {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
    }
    
    access_log /opt/iptv-player/logs/nginx-access.log;
    error_log /opt/iptv-player/logs/nginx-error.log;
}
NGINX

ln -sf /etc/nginx/sites-available/iptv-player /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[6/8] 🔥 Configurando Firewall...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw --force enable

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[7/8] 🔐 Criando ficheiro .env...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
if [ ! -f "$APP_DIR/.env" ]; then
    cat > $APP_DIR/.env << EOF
NODE_ENV=production
PORT=3001
ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 64)
EOF
    chown iptv:iptv $APP_DIR/.env
    chmod 600 $APP_DIR/.env
fi

# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${YELLOW}[8/8] 🏃 Instalando GitHub Actions Runner...${NC}"
# ═══════════════════════════════════════════════════════════════════════════════
cd $RUNNER_DIR

# Detetar arquitetura
ARCH=$(uname -m)
case $ARCH in
    aarch64|arm64) RUNNER_ARCH="arm64" ;;
    armv7l) RUNNER_ARCH="arm" ;;
    x86_64) RUNNER_ARCH="x64" ;;
esac

# Descarregar runner
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/v//')
RUNNER_FILE="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"

if [ ! -f "config.sh" ]; then
    curl -o $RUNNER_FILE -L "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_FILE}"
    tar xzf $RUNNER_FILE
    rm $RUNNER_FILE
fi

chown -R github-runner:github-runner $RUNNER_DIR

# ═══════════════════════════════════════════════════════════════════════════════
# CONCLUÍDO
# ═══════════════════════════════════════════════════════════════════════════════
IP=$(hostname -I | awk '{print $1}')

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║                      ✅ INSTALAÇÃO CONCLUÍDA!                             ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}📋 Próximo passo - Configurar o GitHub Runner:${NC}"
echo ""
echo "1. Vai a: ${CYAN}https://github.com/$GITHUB_REPO/settings/actions/runners/new${NC}"
echo ""
echo "2. Seleciona Linux + ARM64"
echo ""
echo "3. Copia o token do passo 'Configure' e executa:"
echo ""
echo -e "   ${YELLOW}sudo -u github-runner bash${NC}"
echo -e "   ${YELLOW}cd /opt/github-runner${NC}"
echo -e "   ${YELLOW}./config.sh --url https://github.com/$GITHUB_REPO --token SEU_TOKEN_AQUI${NC}"
echo ""
echo "4. Depois de configurar, executa:"
echo ""
echo -e "   ${YELLOW}sudo ./svc.sh install github-runner${NC}"
echo -e "   ${YELLOW}sudo ./svc.sh start${NC}"
echo ""
echo "5. Faz push para o branch 'deploy' e a aplicação será instalada automaticamente!"
echo ""
echo -e "${GREEN}🌐 Após deploy, acede a: http://$IP${NC}"
echo ""
echo -e "${CYAN}📝 Credenciais default: admin / admin123${NC}"
echo ""
