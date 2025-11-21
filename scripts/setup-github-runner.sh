#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# 🏃 GitHub Actions Self-Hosted Runner - Instalação no Raspberry Pi
# ═══════════════════════════════════════════════════════════════════════════════
# Este script instala um runner local no Raspberry Pi para que o GitHub Actions
# possa fazer deploy diretamente, sem precisar de acesso SSH externo.

set -e

echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║     🏃 GitHub Actions Self-Hosted Runner - Raspberry Pi                   ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuração
RUNNER_USER="github-runner"
RUNNER_DIR="/opt/github-runner"

# Verificar arquitetura
ARCH=$(uname -m)
case $ARCH in
    aarch64|arm64)
        RUNNER_ARCH="arm64"
        ;;
    armv7l)
        RUNNER_ARCH="arm"
        ;;
    x86_64)
        RUNNER_ARCH="x64"
        ;;
    *)
        echo -e "${RED}❌ Arquitetura não suportada: $ARCH${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${CYAN}📋 Arquitetura detetada: $ARCH → Runner: $RUNNER_ARCH${NC}"

# Verificar se é root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Por favor executa como root (sudo)${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}📦 1. Instalando dependências...${NC}"
apt update
apt install -y curl jq libicu-dev

echo ""
echo -e "${YELLOW}👤 2. Criando utilizador para o runner...${NC}"
if ! id "$RUNNER_USER" &>/dev/null; then
    useradd -m -s /bin/bash $RUNNER_USER
    usermod -aG sudo $RUNNER_USER
    echo -e "${GREEN}✅ Utilizador '$RUNNER_USER' criado${NC}"
else
    echo -e "${YELLOW}ℹ️  Utilizador '$RUNNER_USER' já existe${NC}"
fi

# Adicionar ao grupo iptv para permissões
usermod -aG iptv $RUNNER_USER 2>/dev/null || true

echo ""
echo -e "${YELLOW}📁 3. Criando diretório do runner...${NC}"
mkdir -p $RUNNER_DIR
chown $RUNNER_USER:$RUNNER_USER $RUNNER_DIR

echo ""
echo -e "${YELLOW}📥 4. Descarregando GitHub Actions Runner...${NC}"

# Obter última versão
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/v//')
RUNNER_FILE="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_FILE}"

echo "Versão: $RUNNER_VERSION"
echo "URL: $RUNNER_URL"

cd $RUNNER_DIR

# Download
if [ ! -f "$RUNNER_FILE" ]; then
    curl -o $RUNNER_FILE -L $RUNNER_URL
fi

echo ""
echo -e "${YELLOW}📦 5. Extraindo runner...${NC}"
tar xzf $RUNNER_FILE
chown -R $RUNNER_USER:$RUNNER_USER $RUNNER_DIR

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║                    ⚠️  AÇÃO MANUAL NECESSÁRIA                              ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${CYAN}Agora precisas de obter o token de registo do GitHub:${NC}"
echo ""
echo "1. Vai a: https://github.com/YOUR_USERNAME/YOUR_REPO/settings/actions/runners/new"
echo ""
echo "2. Seleciona:"
echo "   - Operating System: Linux"
echo "   - Architecture: ARM64 (ou ARM para Pi mais antigos)"
echo ""
echo "3. Copia o token que aparece no comando './config.sh --token XXXXXX'"
echo ""
echo -e "${YELLOW}4. Executa os seguintes comandos:${NC}"
echo ""
echo "   sudo -u $RUNNER_USER bash"
echo "   cd $RUNNER_DIR"
echo "   ./config.sh --url https://github.com/YOUR_USERNAME/YOUR_REPO --token YOUR_TOKEN"
echo ""
echo -e "${YELLOW}5. Depois de configurar, instala como serviço:${NC}"
echo ""
echo "   sudo ./svc.sh install $RUNNER_USER"
echo "   sudo ./svc.sh start"
echo "   sudo ./svc.sh status"
echo ""
echo -e "${GREEN}✅ O runner estará então disponível no GitHub Actions!${NC}"
echo ""
