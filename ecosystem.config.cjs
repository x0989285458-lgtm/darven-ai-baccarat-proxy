module.exports = {
  apps: [
    {
      name: 'draven-mt-proxy-v004',
      script: './src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 3000,
      time: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
        AUTO_CONNECT: 'true',
        CHROME_CAPTURE_URL: '',
        CHROME_CDP_PORT: '9226',
        CHROME_HEADLESS: 'false',
        MT_ORIGIN: 'https://gsa.ofalive99.net',
        MT_PING_INTERVAL_MS: '5000',
      },
    },
  ],
}
