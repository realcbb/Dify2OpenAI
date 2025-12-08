module.exports = {
  apps: [{
    // 应用名称
    name: "dify2openai",

    // 入口文件
    script: "app.js",

    // 实例数量
    instances: 1,

    // 自动重启
    autorestart: true,

    // 监控变化
    watch: false,

    // 默认环境变量
    env: {
      NODE_ENV: "production",
      PORT: 3099
    },

    // 开发环境配置
    env_development: {
      NODE_ENV: "development",
      PORT: 3099
    },

    // 生产环境配置
    env_production: {
      NODE_ENV: "production",
      PORT: 3099
    },

    // 日志配置
    log_file: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    log_file: "./logs/combined.log"
  }]
}
