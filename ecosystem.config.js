// ═══════════════════════════════════════════════════════════════════════════════
// 📦 PM2 Ecosystem Configuration - IPTV Backend
// ═══════════════════════════════════════════════════════════════════════════════
// Coloca este ficheiro em: /opt/iptv-player/ecosystem.config.js

module.exports = {
  apps: [
    {
      // Identificação
      name: 'iptv-backend',
      script: './backend/server.js',
      cwd: '/opt/iptv-player',
      
      // Ambiente
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      
      // Instâncias e Clustering
      instances: 1,  // Raspberry Pi tem recursos limitados
      exec_mode: 'fork',
      
      // Auto-restart
      watch: false,  // Não usar watch em produção
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      
      // Recursos
      max_memory_restart: '200M',  // Reinicia se usar mais de 200MB
      
      // Logs
      log_file: '/opt/iptv-player/logs/combined.log',
      out_file: '/opt/iptv-player/logs/out.log',
      error_file: '/opt/iptv-player/logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 8000,
      
      // Variáveis de ambiente do ficheiro .env
      // PM2 carrega automaticamente de /opt/iptv-player/.env
      env_file: '/opt/iptv-player/.env'
    }
  ],
  
  // Deploy configuration (alternativa ao GitHub Actions)
  deploy: {
    production: {
      user: 'iptv',
      host: 'raspberry.local',  // Muda para o IP ou hostname do teu Raspberry
      ref: 'origin/deploy',
      repo: 'git@github.com:YOUR_USERNAME/YOUR_REPO.git',
      path: '/opt/iptv-player',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
};
