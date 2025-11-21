#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# 🍓 Setup Script para Raspberry Pi - IPTV Player
# ═══════════════════════════════════════════════════════════════════════════════
# Executa este script NO Raspberry Pi como root ou com sudo

set -e

echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║         🍓 Raspberry Pi Setup - IPTV Player                               ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Verificar se é root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Por favor executa como root (sudo)${NC}"
    exit 1
fi

# Variáveis
APP_USER="iptv"
APP_DIR="/opt/iptv-player"
DEPLOY_BRANCH="deploy"

echo ""
echo -e "${YELLOW}📦 1. Atualizando sistema...${NC}"
apt update && apt upgrade -y

echo ""
echo -e "${YELLOW}📦 2. Instalando dependências...${NC}"
apt install -y \
    curl \
    git \
    nginx \
    rsync \
    ufw \
    htop \
    jq

echo ""
echo -e "${YELLOW}📦 3. Instalando Node.js (v20 LTS)...${NC}"
# Usar NodeSource para versão mais recente
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"

echo ""
echo -e "${YELLOW}📦 4. Instalando PM2 (Process Manager)...${NC}"
npm install -g pm2

echo ""
echo -e "${YELLOW}👤 5. Criando utilizador para a aplicação...${NC}"
if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash $APP_USER
    echo -e "${GREEN}✅ Utilizador '$APP_USER' criado${NC}"
else
    echo -e "${YELLOW}ℹ️  Utilizador '$APP_USER' já existe${NC}"
fi

echo ""
echo -e "${YELLOW}📁 6. Criando diretórios da aplicação...${NC}"
mkdir -p $APP_DIR/{backend,frontend,logs,data}
mkdir -p /home/$APP_USER/.ssh

# Configurar permissões
chown -R $APP_USER:$APP_USER $APP_DIR
chown -R $APP_USER:$APP_USER /home/$APP_USER/.ssh
chmod 700 /home/$APP_USER/.ssh

echo ""
echo -e "${YELLOW}🔑 7. Configurando SSH para deploy...${NC}"
# Gerar chave SSH para o utilizador iptv (para GitHub Actions usar)
if [ ! -f /home/$APP_USER/.ssh/authorized_keys ]; then
    touch /home/$APP_USER/.ssh/authorized_keys
    chmod 600 /home/$APP_USER/.ssh/authorized_keys
    chown $APP_USER:$APP_USER /home/$APP_USER/.ssh/authorized_keys
fi

echo ""
echo -e "${YELLOW}🌐 8. Configurando Nginx...${NC}"
cat > /etc/nginx/sites-available/iptv-player << 'NGINX_CONF'
server {
    listen 80;
    server_name _;
    
    # Frontend - arquivos estáticos
    location / {
        root /opt/iptv-player/frontend;
        index index.html;
        try_files $uri $uri/ /index.html;
        
        # Cache para assets estáticos
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
        }
    }
    
    # Backend API - proxy reverso
    location /api {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        
        # Para streaming
        proxy_buffering off;
        proxy_request_buffering off;
    }
    
    # Health check endpoint
    location /health {
        proxy_pass http://127.0.0.1:3001/api/health;
    }
    
    # Logs
    access_log /opt/iptv-player/logs/nginx-access.log;
    error_log /opt/iptv-player/logs/nginx-error.log;
}
NGINX_CONF

# Ativar site e remover default
ln -sf /etc/nginx/sites-available/iptv-player /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Testar configuração
nginx -t

echo ""
echo -e "${YELLOW}🔥 9. Configurando Firewall (UFW)...${NC}"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS (para futuro)
ufw --force enable
ufw status

echo ""
echo -e "${YELLOW}⚙️  10. Configurando PM2 para iniciar no boot...${NC}"
pm2 startup systemd -u $APP_USER --hp /home/$APP_USER
systemctl enable pm2-$APP_USER

echo ""
echo -e "${YELLOW}🔄 11. Reiniciando serviços...${NC}"
systemctl restart nginx
systemctl enable nginx

echo ""
echo -e "${YELLOW}📝 12. Criando script de deploy...${NC}"
cat > $APP_DIR/deploy.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
# Script executado após rsync do código

set -e

APP_DIR="/opt/iptv-player"
LOG_FILE="$APP_DIR/logs/deploy.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

log "═══════════════════════════════════════════════════════"
log "🚀 Iniciando deploy..."

# Backend
log "📦 Instalando dependências do backend..."
cd $APP_DIR/backend
npm ci --production 2>&1 | tee -a $LOG_FILE

# Reiniciar aplicação com PM2
log "🔄 Reiniciando backend com PM2..."
pm2 restart iptv-backend --update-env 2>/dev/null || pm2 start server.js --name iptv-backend
pm2 save

log "✅ Deploy concluído!"
log "═══════════════════════════════════════════════════════"
DEPLOY_SCRIPT

chmod +x $APP_DIR/deploy.sh
chown $APP_USER:$APP_USER $APP_DIR/deploy.sh

echo ""
echo -e "${YELLOW}🔐 13. Configurando variáveis de ambiente...${NC}"
cat > $APP_DIR/.env << 'ENV_FILE'
# Ambiente de produção
NODE_ENV=production
PORT=3001

# Chaves de segurança (MUDAR EM PRODUÇÃO!)
# Gera novas chaves com: openssl rand -hex 32
ENCRYPTION_KEY=change_this_to_a_random_32_byte_hex_string_in_production
JWT_SECRET=change_this_to_a_random_64_byte_hex_string_in_production
ENV_FILE

chown $APP_USER:$APP_USER $APP_DIR/.env
chmod 600 $APP_DIR/.env

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║                      ✅ SETUP CONCLUÍDO!                                  ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}📋 Próximos passos:${NC}"
echo ""
echo "1. ${YELLOW}Gerar chave SSH para GitHub Actions:${NC}"
echo "   sudo -u $APP_USER ssh-keygen -t ed25519 -C 'github-actions-deploy' -f /home/$APP_USER/.ssh/github_actions -N ''"
echo ""
echo "2. ${YELLOW}Copiar a chave PRIVADA para GitHub Secrets:${NC}"
echo "   sudo cat /home/$APP_USER/.ssh/github_actions"
echo "   → Adicionar como secret 'SSH_PRIVATE_KEY' no GitHub"
echo ""
echo "3. ${YELLOW}Adicionar a chave PÚBLICA ao authorized_keys:${NC}"
echo "   sudo cat /home/$APP_USER/.ssh/github_actions.pub >> /home/$APP_USER/.ssh/authorized_keys"
echo ""
echo "4. ${YELLOW}Obter o IP do Raspberry Pi:${NC}"
echo "   hostname -I"
echo "   → Adicionar como secret 'RASPBERRY_HOST' no GitHub"
echo ""
echo "5. ${YELLOW}Atualizar as chaves de segurança em:${NC}"
echo "   $APP_DIR/.env"
echo ""
echo -e "${GREEN}🌐 A aplicação estará disponível em: http://$(hostname -I | awk '{print $1}')${NC}"
echo ""
