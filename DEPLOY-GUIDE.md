# 🚀 Guia de Deploy - IPTV Player no Raspberry Pi

Este guia explica como configurar o deploy automático da aplicação IPTV Player para um Raspberry Pi na rede local.

## 📋 Índice

1. [Pré-requisitos](#pré-requisitos)
2. [Configurar o Raspberry Pi](#1-configurar-o-raspberry-pi)
3. [Configurar o GitHub](#2-configurar-o-github)
4. [Testar o Deploy](#3-testar-o-deploy)
5. [Manutenção](#4-manutenção)
6. [Troubleshooting](#5-troubleshooting)

---

## Pré-requisitos

### No Raspberry Pi:
- Raspberry Pi 3/4/5 com Raspberry Pi OS (64-bit recomendado)
- Acesso à rede local
- Acesso SSH ativo
- Mínimo 1GB RAM livre

### No teu computador:
- Git instalado
- Acesso ao repositório GitHub

---

## 1. Configurar o Raspberry Pi

### 1.1. Aceder ao Raspberry Pi

```bash
# Via SSH (substitui pelo IP do teu Raspberry)
ssh pi@192.168.1.XXX
```

### 1.2. Executar o script de setup

```bash
# Descarregar e executar o script de setup
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/deploy/scripts/setup-raspberry.sh -o setup.sh

# Ou copiar manualmente o conteúdo do ficheiro scripts/setup-raspberry.sh

# Dar permissões e executar
chmod +x setup.sh
sudo ./setup.sh
```

### 1.3. Gerar chaves SSH para GitHub Actions

```bash
# Gerar par de chaves
sudo -u iptv ssh-keygen -t ed25519 -C "github-actions-deploy" -f /home/iptv/.ssh/github_actions -N ""

# Adicionar chave pública ao authorized_keys
sudo cat /home/iptv/.ssh/github_actions.pub >> /home/iptv/.ssh/authorized_keys

# Ver a chave PRIVADA (copiar para GitHub)
sudo cat /home/iptv/.ssh/github_actions
```

### 1.4. Obter o IP do Raspberry Pi

```bash
hostname -I
# Exemplo output: 192.168.1.100
```

### 1.5. Configurar IP Estático (Recomendado)

Para evitar que o IP mude, configura um IP estático:

```bash
# Editar configuração de rede
sudo nano /etc/dhcpcd.conf

# Adicionar no final:
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=192.168.1.1 8.8.8.8

# Reiniciar
sudo reboot
```

---

## 2. Configurar o GitHub

### 2.1. Criar Branch de Deploy

```bash
# No teu computador, no repositório
git checkout -b deploy
git push -u origin deploy
```

### 2.2. Adicionar Secrets no GitHub

Vai a: **Repository → Settings → Secrets and variables → Actions → New repository secret**

Adiciona os seguintes secrets:

| Secret Name | Valor | Descrição |
|-------------|-------|-----------|
| `SSH_PRIVATE_KEY` | Conteúdo da chave privada | A chave de `/home/iptv/.ssh/github_actions` |
| `RASPBERRY_HOST` | `192.168.1.100` | IP do Raspberry Pi |
| `RASPBERRY_USER` | `iptv` | Utilizador para deploy |

### 2.3. Adicionar o Workflow

Copia o ficheiro `.github/workflows/deploy.yml` para o teu repositório:

```bash
mkdir -p .github/workflows
# Copiar o conteúdo do deploy.yml
```

### 2.4. Copiar ficheiros de configuração

```bash
# Copiar ecosystem.config.js para a raiz do projeto
cp ecosystem.config.js /caminho/para/teu/repo/
```

---

## 3. Testar o Deploy

### 3.1. Fazer Push para o Branch Deploy

```bash
git add .
git commit -m "Setup CI/CD pipeline"
git push origin deploy
```

### 3.2. Verificar GitHub Actions

1. Vai a **Repository → Actions**
2. Verifica se o workflow está a executar
3. Clica no workflow para ver os logs detalhados

### 3.3. Verificar no Raspberry Pi

```bash
# Ver estado do PM2
sudo -u iptv pm2 status

# Ver logs da aplicação
sudo -u iptv pm2 logs iptv-backend

# Testar endpoint
curl http://localhost:3001/api/health
```

### 3.4. Aceder à Aplicação

Abre o browser e vai a:
```
http://192.168.1.100
```

---

## 4. Manutenção

### 4.1. Comandos PM2 Úteis

```bash
# Ver estado
sudo -u iptv pm2 status

# Ver logs em tempo real
sudo -u iptv pm2 logs

# Reiniciar aplicação
sudo -u iptv pm2 restart iptv-backend

# Parar aplicação
sudo -u iptv pm2 stop iptv-backend

# Ver métricas
sudo -u iptv pm2 monit
```

### 4.2. Ver Logs

```bash
# Logs do backend
tail -f /opt/iptv-player/logs/out.log

# Logs de erro
tail -f /opt/iptv-player/logs/error.log

# Logs do Nginx
tail -f /opt/iptv-player/logs/nginx-access.log
tail -f /opt/iptv-player/logs/nginx-error.log

# Logs de deploy
tail -f /opt/iptv-player/logs/deploy.log
```

### 4.3. Atualizar Chaves de Segurança

```bash
# Editar .env
sudo nano /opt/iptv-player/.env

# Gerar nova chave
openssl rand -hex 32  # Para ENCRYPTION_KEY
openssl rand -hex 64  # Para JWT_SECRET

# Reiniciar após mudanças
sudo -u iptv pm2 restart iptv-backend
```

### 4.4. Backup dos Dados

```bash
# Backup dos utilizadores encriptados
cp /opt/iptv-player/backend/data/users.enc /backup/users.enc.$(date +%Y%m%d)
```

---

## 5. Troubleshooting

### ❌ GitHub Actions não consegue ligar ao Raspberry Pi

**Causa:** O Raspberry está numa rede privada, GitHub não consegue aceder diretamente.

**Solução:** Usar um self-hosted runner ou túnel:

```bash
# Opção 1: Cloudflare Tunnel (recomendado para produção)
# Opção 2: ngrok (para testes)
# Opção 3: Self-hosted GitHub Runner
```

### ❌ Erro "Permission denied" no SSH

```bash
# Verificar permissões
sudo chmod 700 /home/iptv/.ssh
sudo chmod 600 /home/iptv/.ssh/authorized_keys
sudo chown -R iptv:iptv /home/iptv/.ssh
```

### ❌ PM2 não inicia no boot

```bash
# Reconfigurar startup
sudo -u iptv pm2 startup systemd -u iptv --hp /home/iptv
sudo -u iptv pm2 save
```

### ❌ Nginx retorna 502 Bad Gateway

```bash
# Verificar se o backend está a correr
sudo -u iptv pm2 status

# Verificar se a porta está correta
curl http://localhost:3001/api/health

# Verificar logs do Nginx
tail -f /var/log/nginx/error.log
```

### ❌ Aplicação não guarda dados após restart

```bash
# Verificar permissões do diretório data
sudo chown -R iptv:iptv /opt/iptv-player/backend/data
sudo chmod 755 /opt/iptv-player/backend/data
```

---

## 🔒 Notas de Segurança

1. **Mudar credenciais default** - Altera a password do admin após primeiro login
2. **Atualizar chaves de encriptação** - Gera novas chaves para ENCRYPTION_KEY e JWT_SECRET
3. **Manter sistema atualizado** - `sudo apt update && sudo apt upgrade`
4. **Firewall ativo** - Apenas portas 22 (SSH) e 80 (HTTP) abertas
5. **Rede local apenas** - A aplicação só está acessível na rede local

---

## 📁 Estrutura no Raspberry Pi

```
/opt/iptv-player/
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── node_modules/
│   └── data/
│       └── users.enc
├── frontend/
│   ├── index.html
│   └── admin.html
├── logs/
│   ├── out.log
│   ├── error.log
│   ├── deploy.log
│   ├── nginx-access.log
│   └── nginx-error.log
├── .env
├── deploy.sh
└── ecosystem.config.js
```

---

## 🔄 Fluxo de Deploy

```
1. Developer faz push para branch 'deploy'
          ↓
2. GitHub Actions detecta o push
          ↓
3. Workflow executa testes básicos
          ↓
4. Rsync sincroniza ficheiros para Raspberry Pi
          ↓
5. Script deploy.sh executa:
   - npm ci --production
   - pm2 restart
          ↓
6. Health check verifica se está online
          ↓
7. ✅ Deploy concluído!
```

---

## 🆘 Suporte

Se tiveres problemas:
1. Verifica os logs do GitHub Actions
2. Verifica os logs no Raspberry Pi
3. Confirma que os secrets estão corretos
4. Verifica conectividade de rede
