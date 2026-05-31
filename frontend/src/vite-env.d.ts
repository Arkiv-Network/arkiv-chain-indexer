/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOKEN_SYMBOL?: string;
  readonly VITE_TRANSACTION_EXPLORER_BASE_URL?: string;
  readonly VITE_NO_BATCHER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}
