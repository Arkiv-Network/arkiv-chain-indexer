/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_NAME?: string;
  readonly VITE_TOKEN_SYMBOL?: string;
  readonly VITE_TRANSACTION_DECODER_BASE_URL?: string;
  readonly VITE_TRANSACTION_EXPLORER_BASE_URL?: string;
  readonly VITE_BLOCK_TIME_MS?: string;
  readonly VITE_STUB_TICK_MS?: string;
  readonly VITE_MAX_STUB_BLOCKS?: string;
  readonly VITE_STUB_VISIBLE_AGE_MS?: string;
  readonly VITE_PING_START_AGE_MS?: string;
  readonly VITE_LOADING_METADATA_LEAD_MS?: string;
  readonly VITE_NEXT_BLOCK_PING_MS?: string;
  readonly VITE_PING_MIN_INTERVAL_MS?: string;
  readonly VITE_SCANNER_DELAY_WARNING_AGE_MS?: string;
  readonly VITE_HISTOGRAM_WINDOW_MINUTES?: string;
  readonly VITE_HISTOGRAM_REFRESH_MS?: string;
  readonly VITE_HISTOGRAM_CLOCK_TICK_MS?: string;
  readonly VITE_NO_BATCHER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}
