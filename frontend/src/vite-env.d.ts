/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 部署版后端 API 地址（如 https://xxx.trycloudflare.com），留空 = 同源 /api */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
