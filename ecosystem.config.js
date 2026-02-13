module.exports = {
  apps: [
    {
      name: 'vipersnipe',
      script: 'dist/index.js',
      node_args: '--experimental-specifier-resolution=node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: 10000,
    },
  ],
};
